import { ProviderError } from "../errors";

/**
 * The only way the Network Finder reads public web pages and public APIs:
 *  - identifies itself honestly (User-Agent), never logs in, never sends cookies or reuses a browser session;
 *  - obeys robots.txt (a disallowed or unreadable-but-forbidden path is refused, not worked around);
 *  - paces requests per host (default 1 request / second, or the site's Crawl-delay if larger);
 *  - honours 429 / Retry-After by throwing `rate_limited` with the time to come back;
 *  - caps time and size, and reads text only.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const USER_AGENT = "JobSyncNetworkFinder/1.0 (+private job-search assistant; respects robots.txt)";
const TIMEOUT_MS = 12_000;
/** Pages are capped smaller than API responses (a full public job feed can be a few MB). */
const MAX_PAGE_BYTES = 1_500_000;
const MAX_JSON_BYTES = 8_000_000;
const DEFAULT_GAP_MS = 1_000;

export interface PoliteResponse {
  url: string;
  status: number;
  contentType: string;
  text: string;
}

interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelayMs?: number;
}

/** Parses the groups that apply to us (our token, else "*"). */
export function parseRobots(txt: string, agentToken = "jobsyncnetworkfinder"): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { allow: [], disallow: [] } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "disallow" && value) current.rules.disallow.push(value);
    else if (key === "allow" && value) current.rules.allow.push(value);
    else if (key === "crawl-delay" && Number.isFinite(Number(value))) current.rules.crawlDelayMs = Math.min(30_000, Number(value) * 1000);
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agentToken.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return chosen.reduce<RobotsRules>(
    (acc, g) => ({ allow: [...acc.allow, ...g.rules.allow], disallow: [...acc.disallow, ...g.rules.disallow], crawlDelayMs: g.rules.crawlDelayMs ?? acc.crawlDelayMs }),
    { allow: [], disallow: [] },
  );
}

const ruleRegex = (rule: string) => new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);

/** Longest matching rule wins; Allow wins a tie (Google's interpretation). */
export function robotsAllows(rules: RobotsRules, pathAndQuery: string): boolean {
  let best: { len: number; allow: boolean } = { len: -1, allow: true };
  for (const [list, allow] of [[rules.disallow, false], [rules.allow, true]] as const) {
    for (const r of list) {
      if (ruleRegex(r).test(pathAndQuery) && (r.length > best.len || (r.length === best.len && allow))) best = { len: r.length, allow };
    }
  }
  return best.allow;
}

export class PoliteFetcher {
  private robots = new Map<string, Promise<RobotsRules | "blocked">>();
  private nextSlot = new Map<string, number>();
  /** Every request made (URL only), for tests and the run report. */
  readonly log: string[] = [];

  constructor(
    private readonly fetchFn: FetchLike = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = Date.now,
    private readonly gapMs: number = DEFAULT_GAP_MS,
  ) {}

  private async raw(url: string, accept: string, crawlDelayMs = 0): Promise<Response> {
    const host = new URL(url).host;
    const at = this.now();
    const slot = Math.max(at, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + Math.max(this.gapMs, crawlDelayMs));
    if (slot > at) await this.sleep(slot - at);
    this.log.push(url);
    // No cookies, no credentials, no session: a plain anonymous request.
    return this.fetchFn(url, { method: "GET", redirect: "follow", credentials: "omit", headers: { "User-Agent": USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  private rulesFor(origin: string): Promise<RobotsRules | "blocked"> {
    let p = this.robots.get(origin);
    if (!p) {
      p = (async () => {
        try {
          const res = await this.raw(`${origin}/robots.txt`, "text/plain");
          // No robots.txt (4xx) = no restrictions; 401/403 on robots.txt = treat the whole site as off-limits.
          if (res.status === 401 || res.status === 403) return "blocked" as const;
          if (!res.ok) return { allow: [], disallow: [] };
          return parseRobots((await res.text()).slice(0, 200_000));
        } catch {
          // Unreachable robots.txt (5xx/timeout): be conservative and skip the site this run.
          return "blocked" as const;
        }
      })();
      this.robots.set(origin, p);
    }
    return p;
  }

  /** Successful responses of this run (one fetcher per run), so a page read by two steps is fetched once. */
  private cache = new Map<string, PoliteResponse>();

  /** GET a public page or API. Throws ProviderError (forbidden / rate_limited / unavailable / invalid_response). */
  async get(url: string, provider: string, options: { accept?: string; checkRobots?: boolean } = {}): Promise<PoliteResponse> {
    const cached = this.cache.get(url);
    if (cached) return cached;
    const res = await this.fetchOnce(url, provider, options);
    if (res.status === 200) this.cache.set(url, res);
    return res;
  }

  private async fetchOnce(url: string, provider: string, options: { accept?: string; checkRobots?: boolean }): Promise<PoliteResponse> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ProviderError(provider, "invalid_response", "bad URL");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new ProviderError(provider, "invalid_response", "not an http(s) URL");
    let crawlDelay = 0;
    if (options.checkRobots !== false) {
      const rules = await this.rulesFor(u.origin);
      if (rules === "blocked" || !robotsAllows(rules, `${u.pathname}${u.search}`)) throw new ProviderError(provider, "forbidden", `robots.txt does not allow ${u.host}${u.pathname}`);
      crawlDelay = rules.crawlDelayMs ?? 0;
    }
    let res: Response;
    try {
      res = await this.raw(u.toString(), options.accept ?? "text/html,application/json;q=0.9,*/*;q=0.5", crawlDelay);
    } catch {
      throw new ProviderError(provider, "unavailable", `${u.host} did not respond`);
    }
    if (res.status === 429 || res.status === 503) {
      const ra = res.headers.get("retry-after");
      const secs = ra && /^\d+$/.test(ra.trim()) ? Number(ra) : ra ? Math.max(0, (Date.parse(ra) - this.now()) / 1000) : 60;
      throw new ProviderError(provider, res.status === 429 ? "rate_limited" : "unavailable", `${u.host} asked us to slow down`, this.now() + Math.min(secs, 24 * 3600) * 1000);
    }
    if (res.status === 401 || res.status === 403) throw new ProviderError(provider, "forbidden", `${u.host} refused access (${res.status}); not worked around`);
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) return { url: res.url || u.toString(), status: res.status, contentType, text: "" };
    if (!/text\/|json|xml/i.test(contentType) && contentType) return { url: res.url || u.toString(), status: res.status, contentType, text: "" };
    const text = await res.text().catch(() => "");
    const max = /json/i.test(contentType) ? MAX_JSON_BYTES : MAX_PAGE_BYTES;
    if (text.length > max && /json/i.test(contentType)) throw new ProviderError(provider, "invalid_response", `response larger than ${max} bytes`);
    return { url: res.url || u.toString(), status: res.status, contentType, text: text.slice(0, max) };
  }

  async getJson<T>(url: string, provider: string, options: { checkRobots?: boolean } = {}): Promise<T | null> {
    const r = await this.get(url, provider, { accept: "application/json", ...options });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new ProviderError(provider, r.status >= 500 ? "unavailable" : "invalid_response", `status ${r.status}`);
    try {
      return JSON.parse(r.text) as T;
    } catch {
      throw new ProviderError(provider, "invalid_response", `not JSON (${r.text.length} bytes, ${r.contentType || "no content type"})`);
    }
  }
}
