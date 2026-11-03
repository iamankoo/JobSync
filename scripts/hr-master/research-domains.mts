/**
 * Stage 3: research every company-owned e-mail domain ONCE by reading its public homepage and careers page.
 *
 *   node --experimental-strip-types --no-warnings scripts/hr-master/research-domains.mts [--limit N] [--concurrency N] [--retry-errors]
 *
 * - Resume-safe: results are appended to data/hr-master/work/domain-research.jsonl as they complete; domains already in the
 *   file are skipped on the next run (use --retry-errors to redo unreachable/error ones). Kill it any time.
 * - Polite: honours robots.txt, one site at a time per domain, identifying User-Agent, short timeouts, no login/CAPTCHA bypass.
 * - Public pages only. Nothing is written anywhere except data/hr-master/work/.
 */
import fs from "node:fs";
import path from "node:path";
import { findCareersUrl, jobTitlesIn, looksParked, parsePage, parseResearchJsonl, robotsAllows, selectPendingDomains } from "../../src/lib/hr-master/research.ts";
import { registrableDomain } from "../../src/lib/hr-master/normalize.ts";
import type { CompanyResearch, MergedContact } from "../../src/lib/hr-master/types.ts";
import { WORK_DIR } from "./paths.mts";

const args = process.argv.slice(2);
const argNum = (f: string, d: number) => (args.includes(f) ? Number(args[args.indexOf(f) + 1]) : d);
const LIMIT = argNum("--limit", Infinity);
const CONCURRENCY = argNum("--concurrency", 40);
const RETRY = args.includes("--retry-errors");
const UA = "JobSyncResearch/1.0 (company website verification for a personal job-search project)";
const TIMEOUT_MS = 8_000;
const MAX_BYTES = 400_000;

const OUT = path.join(WORK_DIR, "domain-research.jsonl");
const PROGRESS = path.join(WORK_DIR, "research-progress.json");

const deduped = JSON.parse(fs.readFileSync(path.join(WORK_DIR, "deduped.json"), "utf8")) as { contacts: MergedContact[] };
const domains = [...new Set(deduped.contacts.filter((c) => c.emailKind === "company").map((c) => c.emailDomain))].sort();

const done = fs.existsSync(OUT) ? parseResearchJsonl(fs.readFileSync(OUT, "utf8")) : new Map<string, CompanyResearch>();
const todo = selectPendingDomains(domains, done, { retryErrors: RETRY, limit: LIMIT });

console.log(`domains total ${domains.length}, already researched ${done.size}, to do now ${todo.length}`);

async function get(url: string, accept = "text/html,application/xhtml+xml"): Promise<{ ok: boolean; status: number; finalUrl: string; body: string; type: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": UA, accept, "accept-language": "en" } });
    const type = res.headers.get("content-type") ?? "";
    let body = "";
    if (res.body && (/text|html|xml|json/i.test(type) || type === "")) {
      const reader = res.body.getReader();
      const dec = new TextDecoder("utf-8", { fatal: false });
      let total = 0;
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d || !value) break;
        total += value.byteLength;
        body += dec.decode(value, { stream: true });
        if (total >= MAX_BYTES) {
          await reader.cancel();
          break;
        }
      }
    }
    return { ok: res.ok, status: res.status, finalUrl: res.url || url, body, type };
  } finally {
    clearTimeout(timer);
  }
}

async function researchDomain(domain: string): Promise<CompanyResearch> {
  const base: CompanyResearch = { domain, status: "unreachable", fetchedAt: new Date().toISOString(), sources: [] };
  let home: Awaited<ReturnType<typeof get>> | null = null;
  let lastErr = "";
  for (const url of [`https://${domain}/`, `https://www.${domain}/`, `http://${domain}/`]) {
    try {
      home = await get(url);
      if (home.ok && /html/i.test(home.type || "html")) break;
      lastErr = `HTTP ${home.status}`;
      home = null;
    } catch (e) {
      lastErr = (e as { cause?: { code?: string }; name?: string }).cause?.code ?? (e as Error).name ?? "fetch failed";
      home = null;
    }
  }
  if (!home) return { ...base, error: lastErr };

  let origin: URL;
  try {
    origin = new URL(home.finalUrl);
  } catch {
    return { ...base, status: "error", error: "bad final URL" };
  }

  // robots.txt (best effort): a fetch error means "no rules".
  try {
    const robots = await get(`${origin.origin}/robots.txt`, "text/plain");
    if (robots.ok && !robotsAllows(robots.body, "/")) {
      return { ...base, status: "blocked-by-robots", finalUrl: origin.origin + "/", finalDomain: registrableDomain(origin.hostname) };
    }
  } catch {
    /* ignore */
  }

  const page = parsePage(home.body);
  const common = {
    ...base,
    finalUrl: origin.origin + "/",
    finalDomain: registrableDomain(origin.hostname),
    siteName: page.siteName || undefined,
    title: page.title || undefined,
    description: page.description || undefined,
    sources: [origin.origin + "/"],
  };
  if (looksParked(page)) return { ...common, status: "parked" };

  const linkFound = findCareersUrl(page, home.finalUrl);
  let careersUrl = linkFound;
  let careersText = "";
  const candidates = linkFound ? [linkFound] : [`${origin.origin}/careers`, `${origin.origin}/jobs`];
  for (const cu of candidates) {
    try {
      const cpath = new URL(cu).pathname;
      const robots = await get(`${new URL(cu).origin}/robots.txt`, "text/plain").catch(() => null);
      if (robots?.ok && !robotsAllows(robots.body, cpath)) continue;
      const res = await get(cu);
      if (res.ok && /html/i.test(res.type || "html")) {
        const cp = parsePage(res.body);
        if (cp.text.length > 200 && !looksParked(cp)) {
          careersUrl = res.finalUrl;
          careersText = cp.text.slice(0, 40_000);
          break;
        }
      }
    } catch {
      /* try the next candidate */
    }
  }
  const titles = [...new Set(jobTitlesIn(careersText).map((t) => t.phrase))].slice(0, 12);
  return {
    ...common,
    status: "researched",
    careersUrl: careersText || linkFound ? careersUrl : undefined,
    careersTitles: careersText ? titles : undefined,
    textSample: page.text.slice(0, 6000),
    sources: [...common.sources, ...(careersText ? [careersUrl] : [])],
  };
}

let finished = 0;
const counts: Record<string, number> = {};
const startedAt = new Date().toISOString();
const out = fs.createWriteStream(OUT, { flags: "a" });
let cursor = 0;
let stop = false;
process.on("SIGINT", () => {
  stop = true;
  console.log("\nstopping after in-flight domains finish (progress is saved)...");
});

function writeProgress() {
  fs.writeFileSync(PROGRESS, JSON.stringify({ totalDomains: domains.length, researchedBefore: done.size, researchedThisRun: finished, startedAt, updatedAt: new Date().toISOString(), statusCountsThisRun: counts }, null, 2));
}

async function worker() {
  while (!stop && cursor < todo.length) {
    const domain = todo[cursor++];
    let r: CompanyResearch;
    try {
      r = await researchDomain(domain);
    } catch (e) {
      r = { domain, status: "error", fetchedAt: new Date().toISOString(), sources: [], error: (e as Error).name };
    }
    out.write(JSON.stringify(r) + "\n");
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (++finished % 200 === 0) {
      writeProgress();
      console.log(`${finished}/${todo.length}`, JSON.stringify(counts));
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await new Promise((r) => out.end(r));
writeProgress();
console.log("done this run:", finished, JSON.stringify(counts), stop ? "(interrupted - rerun to resume)" : "");
