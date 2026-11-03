import { isPublicHostname } from "@/lib/utils/url";
export { isPublicHostname };
import type { EmailJob } from "./email-composer";
import { decodeEntitiesForResearch, extractPageSummary } from "./http/page-summary";
import type { PoliteFetcher } from "./http/polite-fetch";
import type { JobSource } from "./providers/types";
import type { JobCandidate } from "./types";

/**
 * What the email writer may know about a company, from sources the application is allowed to read:
 * the company's OWN website (its own description of itself) and its OWN careers board (Greenhouse, Lever, Ashby).
 * Nothing is guessed: a website is accepted only when the page really names the company, a description is
 * the company's own wording, and a job exists only if the board lists it. No result means the email speaks of the
 * role family and states no company facts.
 */
export interface CompanyResearch {
  website?: string;
  /** The company's own description of what it does (its site's meta description), verbatim. */
  description?: string;
  /** Open roles on the company's own board, with the board's descriptions where it gives them. */
  jobs: JobCandidate[];
  /** The official pages actually read (home plus those linked from it when a Company URL was supplied), with their URLs. */
  pages?: ResearchPage[];
  /** Verbatim sentences from those pages (each page's own description), beyond `description`. Every one has its page in `pages`. */
  facts?: string[];
  /** verified = several official pages read; partial = only the home page; unavailable = nothing could be read (no company facts). */
  status?: ResearchStatus;
  /** ISO time the pages were read. */
  fetchedAt?: string;
  /** True when this came from the stored research of an earlier run (no new requests were made). */
  reused?: boolean;
}

export type ResearchStatus = "verified" | "partial" | "unavailable";
export type ResearchPageKind = "home" | "about" | "products" | "engineering" | "careers" | "blog";
export interface ResearchPage {
  kind: ResearchPageKind;
  /** Where it was read (the provenance of anything taken from it). */
  url: string;
  title: string;
  /** The page's own description, verbatim (cut at 300 characters). */
  summary?: string;
}

export interface CompanyResearchInput {
  name: string;
  website?: string;
  /** A contact's work email, whose domain is the strongest hint for the website (free-mail providers are ignored). */
  email?: string;
}

export type CompanyResearcher = (input: CompanyResearchInput) => Promise<CompanyResearch>;

const FREE_MAIL = /(^|\.)(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|proton|protonmail|aol|gmx|zoho|yandex|mail|rediffmail|msn)\.[a-z.]+$/i;
const TLDS = ["com", "ai", "io", "co", "app", "dev", "so", "tech", "xyz"];

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const stripSuffix = (s: string) => s.replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|gmbh|co)\b\.?/gi, " ").replace(/\s+/g, " ").trim();


/** Likely website addresses for a company name, most likely first (each is VERIFIED against the page before use). */
export function websiteCandidates(name: string, email?: string): string[] {
  const out: string[] = [];
  const domain = email?.split("@")[1]?.toLowerCase();
  if (domain && !FREE_MAIL.test(domain) && isPublicHostname(domain)) out.push(`https://${domain}/`);
  const base = stripSuffix(name);
  const compact = alnum(base);
  const dashed = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // "Magic Hour AI" → magichourai, magichour (without a trailing "ai"/"labs"), magic-hour
  const short = alnum(base.replace(/\b(ai|labs?|technologies|technology|hq|app|io)\b/gi, " "));
  const slugs = [...new Set([compact, short, dashed].filter((s) => s.length >= 3))];
  for (const tld of TLDS) for (const slug of slugs) out.push(`https://${slug}.${tld}/`);
  return [...new Set(out)];
}

/** True when the page names the company (title, site name or visible text). */
export function pageNamesCompany(html: string, name: string, strict = false): boolean {
  const key = alnum(stripSuffix(name));
  if (key.length < 3) return false;
  const { title, siteName, text } = extractPageSummary(html);
  const head = alnum(`${title} ${siteName}`);
  if (head.includes(key)) return true;
  // A guessed address (no website or work email to go by) must carry the company's FULL name: a shorter match could be another company.
  if (strict) return false;
  // Also accept the name without a trailing "AI"/"Labs" word when the page text names it as a whole word.
  const short = alnum(stripSuffix(name).replace(/\b(ai|labs?|technologies|technology|hq)\b/gi, " "));
  return short.length >= 4 && alnum(text.slice(0, 3000)).includes(short) && alnum(`${title} ${siteName}`).includes(short);
}

const MAX_SITE_TRIES = 8;
/** Official pages read besides the home page when a Company URL was supplied. */
const MAX_EXTRA_PAGES = 5;
/** Verified research is reused for this long when the company and URL are unchanged. */
export const RESEARCH_TTL_MS = 14 * 24 * 3_600_000;
/** A failed attempt is not repeated for a while (no hammering of a site that refused or did not answer). */
export const RESEARCH_RETRY_MS = 6 * 3_600_000;

/** Where research is kept between runs (the Network Finder's existing NF_State notes). */
export interface ResearchStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

const PAGE_KINDS: { kind: Exclude<ResearchPageKind, "home">; pattern: RegExp }[] = [
  { kind: "about", pattern: /\b(about|who[- ]we[- ]are|our[- ]story|company)\b/i },
  { kind: "products", pattern: /\b(products?|solutions?|services?|platform|what[- ]we[- ]do)\b/i },
  { kind: "engineering", pattern: /\b(engineering|technology|tech|developers?|research)\b/i },
  { kind: "careers", pattern: /\b(careers?|jobs|join[- ]us|work[- ]with[- ]us|hiring|open[- ]roles)\b/i },
  { kind: "blog", pattern: /\b(blog|news|press|insights|updates)\b/i },
];

const sameSite = (a: string, b: string) => a.toLowerCase().replace(/^www\./, "") === b.toLowerCase().replace(/^www\./, "");

/**
 * The company's own pages linked from its home page, one per kind, in a fixed order. Only same-site http(s) links found
 * in the page are followed (nothing is guessed), without query strings or fragments.
 */
export function discoverPages(html: string, base: string): { kind: Exclude<ResearchPageKind, "home">; url: string }[] {
  let root: URL;
  try {
    root = new URL(base);
  } catch {
    return [];
  }
  const found = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const href = (m[1] ?? m[2] ?? "").trim();
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href, root);
    } catch {
      continue;
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !sameSite(u.hostname, root.hostname) || u.username || u.password) continue;
    u.hash = "";
    u.search = "";
    if (u.pathname === "/" || u.pathname === root.pathname) continue;
    const label = decodeEntitiesForResearch(m[3].replace(/<[^>]+>/g, " ")).slice(0, 60);
    const hay = `${u.pathname.replace(/[-_/]/g, " ")} ${label}`;
    for (const { kind, pattern } of PAGE_KINDS) {
      if (!found.has(kind) && pattern.test(hay) && !/\.(pdf|png|jpe?g|svg|zip|docx?)$/i.test(u.pathname)) {
        found.set(kind, u.toString());
        break;
      }
    }
  }
  return PAGE_KINDS.filter((k) => found.has(k.kind)).map((k) => ({ kind: k.kind, url: found.get(k.kind)! }));
}

const oneLine = (s: string, max: number) => decodeEntitiesForResearch(s).slice(0, max);

/**
 * A page's own description cut to whole sentences: when it is longer than `max`, only the sentences that fit are kept (and
 * nothing at all if even the first does not fit). Never a fragment that stops mid-sentence.
 */
export function wholeSentences(s: string, max: number): string {
  const text = decodeEntitiesForResearch(s);
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return end >= 20 ? head.slice(0, end + 1) : "";
}

function pageOf(kind: ResearchPageKind, url: string, html: string): ResearchPage | undefined {
  const { title, description } = extractPageSummary(html);
  if (!title && !description) return undefined;
  const summary = description ? wholeSentences(description, 300) : "";
  return { kind, url, title: oneLine(title, 140), ...(summary ? { summary } : {}) };
}

const dedupe = (xs: string[]) => [...new Set(xs.filter(Boolean))];

function parseStored(raw: string | undefined): (CompanyResearch & { startUrl?: string; fetchedAt: string; status: ResearchStatus }) | undefined {
  try {
    const r = raw ? JSON.parse(raw) : undefined;
    if (r && r.v === 1 && typeof r.fetchedAt === "string" && ["verified", "partial", "unavailable"].includes(r.status)) return { ...r.data, startUrl: r.startUrl, fetchedAt: r.fetchedAt, status: r.status };
  } catch {
    // unreadable note: research again
  }
  return undefined;
}

export interface CompanyResearcherOptions {
  deadline?: () => number | undefined;
  store?: ResearchStore;
  now?: () => number;
}

export function createCompanyResearcher(fetcher: PoliteFetcher, boards: JobSource, options: CompanyResearcherOptions = {}): CompanyResearcher {
  const cache = new Map<string, Promise<CompanyResearch>>();
  const clock = options.now ?? Date.now;
  const timeUp = () => {
    const d = options.deadline?.();
    return d !== undefined && d - clock() < 12_000;
  };

  async function research(input: CompanyResearchInput): Promise<CompanyResearch> {
    const supplied = Boolean(input.website);
    const result: CompanyResearch = { jobs: [] };
    let site = input.website;
    let html: string | undefined;
    try {
      const candidates = site ? [site] : websiteCandidates(input.name, input.email).slice(0, MAX_SITE_TRIES + 20);
      let tries = 0;
      for (const url of candidates) {
        if (timeUp() || (!site && tries >= MAX_SITE_TRIES + (input.email ? 1 : 0))) break;
        tries += 1;
        try {
          const r = await fetcher.get(url, "company-research");
          if (r.status !== 200) continue;
          // The contact's work-email domain is the company's own; a guessed address needs the page to carry the full name.
          const fromEmail = Boolean(input.email) && url === candidates[0];
          if (site || pageNamesCompany(r.text, input.name, !fromEmail)) {
            site = r.url || url;
            html = r.text;
            break;
          }
        } catch {
          // Not reachable / not allowed: try the next address.
        }
      }
    } catch {
      // No website could be established: the email then states no company facts.
    }
    if (!site || !html) {
      // A supplied URL that could not be read is still reported as the place research started from.
      if (supplied) result.website = input.website;
      return result;
    }
    result.website = site;
    const pages: ResearchPage[] = [];
    const home = pageOf("home", site, html);
    if (home) pages.push(home);
    const description = extractPageSummary(html).description;
    const whole = description ? wholeSentences(description, 300) : "";
    if (whole) result.description = whole;
    // A supplied Company URL is the starting point: the official pages it links to are read too (robots.txt, pacing and
    // the access rules of PoliteFetcher apply to each; a page that is missing or refused is simply left out).
    if (supplied) {
      for (const link of discoverPages(html, site).slice(0, MAX_EXTRA_PAGES)) {
        if (timeUp()) break;
        try {
          const r = await fetcher.get(link.url, "company-research");
          if (r.status !== 200 || !r.text) continue;
          const page = pageOf(link.kind, r.url || link.url, r.text);
          if (page) pages.push(page);
        } catch {
          // refused / unreachable: not part of the research
        }
      }
    }
    if (pages.length) result.pages = pages;
    const facts = dedupe(pages.map((p) => p.summary ?? "")).filter((f) => f !== result.description);
    if (facts.length) result.facts = facts.slice(0, 4);
    if (!timeUp()) {
      try {
        result.jobs = await boards.findCompanyJobs({ name: input.name, key: alnum(input.name), website: site } as never);
      } catch {
        result.jobs = []; // board not reachable right now: no verified job
      }
    }
    return result;
  }

  async function withStore(input: CompanyResearchInput): Promise<CompanyResearch> {
    const key = `research:${alnum(input.name)}`;
    const startUrl = input.website ?? "";
    const stored = options.store ? parseStored(await options.store.get(key).catch(() => undefined)) : undefined;
    if (stored && (stored.startUrl ?? "") === startUrl) {
      const age = clock() - Date.parse(stored.fetchedAt);
      // Same company and URL, recent enough: reused as-is (no requests). A failed attempt waits out the retry gap.
      if (age >= 0 && age < (stored.status === "unavailable" ? RESEARCH_RETRY_MS : RESEARCH_TTL_MS)) return { ...stored, reused: true, jobs: stored.jobs ?? [] };
    }
    const fresh = await research(input);
    const status: ResearchStatus = !fresh.website || !(fresh.description || fresh.pages?.length) ? "unavailable" : fresh.pages && fresh.pages.length > 1 ? "verified" : "partial";
    const out: CompanyResearch = { ...fresh, status, fetchedAt: new Date(clock()).toISOString(), ...(startUrl ? { startUrl } : {}) };
    if (options.store && !timeUp()) {
      const { jobs, ...rest } = out;
      const slim = jobs.slice(0, 8).map((j) => ({ ...j, ...(j.description ? { description: j.description.slice(0, 600) } : {}) }));
      await options.store.set(key, JSON.stringify({ v: 1, startUrl, fetchedAt: out.fetchedAt, status, data: { ...rest, jobs: slim } })).catch(() => undefined);
    }
    return out;
  }

  return (input) => {
    const key = `${alnum(input.name)}|${input.website ?? ""}|${input.email?.split("@")[1] ?? ""}`;
    let p = cache.get(key);
    if (!p) {
      p = withStore(input);
      cache.set(key, p);
    }
    return p;
  };
}

/** A researched job as the email writer's job input. */
export const asEmailJob = (j: JobCandidate): EmailJob => ({
  title: j.title,
  ...(j.description ? { description: j.description } : {}),
  internship: j.employment === "internship" || /\bintern(ship)?\b/i.test(j.title),
  ...(j.location ? { location: j.location } : {}),
  ...(j.workplace ? { workMode: j.workplace } : j.remote ? { workMode: "Remote" } : {}),
});
