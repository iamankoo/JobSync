/**
 * Stage 3b: for company domains whose role is still Unverified and whose HOMEPAGE headline did not settle software-vs-AI,
 * read the public About page (robots.txt honoured). Resume-safe via work/about-research.jsonl.
 *   node --experimental-strip-types --no-warnings scripts/hr-master/research-about.mts [--concurrency 50]
 */
import fs from "node:fs";
import path from "node:path";
import { classifyCompanyFocus } from "../../src/lib/hr-master/company-focus.ts";
import { assessRole, looksParked, parsePage, parseResearchJsonl, robotsAllows } from "../../src/lib/hr-master/research.ts";
import type { AboutPage } from "../../src/lib/hr-master/master.ts";
import { WORK_DIR } from "./paths.mts";

const args = process.argv.slice(2);
const CONCURRENCY = args.includes("--concurrency") ? Number(args[args.indexOf("--concurrency") + 1]) : 50;
const UA = "JobSyncResearch/1.0 (company website verification for a personal job-search project)";
const OUT = path.join(WORK_DIR, "about-research.jsonl");

const research = parseResearchJsonl(fs.readFileSync(path.join(WORK_DIR, "domain-research.jsonl"), "utf8"));
const done = new Set<string>();
if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, "utf8").split("\n")) { try { done.add((JSON.parse(l) as AboutPage).domain); } catch { /* partial line */ } }

const todo = [...research.values()]
  .filter((r) => r.status === "researched" && assessRole(r).primary === "Unverified" && !classifyCompanyFocus({ title: r.title, siteName: r.siteName, description: r.description }))
  .map((r) => r.domain)
  .filter((d) => !done.has(d))
  .sort();
console.log(`about-page candidates to fetch: ${todo.length} (already done ${done.size})`);

async function get(url: string): Promise<{ ok: boolean; url: string; body: string; type: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": UA, accept: "text/html,text/plain" } });
    const type = res.headers.get("content-type") ?? "";
    const body = /html|text/i.test(type) ? (await res.text()).slice(0, 400_000) : "";
    return { ok: res.ok, url: res.url || url, body, type };
  } finally {
    clearTimeout(t);
  }
}

async function aboutFor(domain: string): Promise<AboutPage | null> {
  const origin = new URL(research.get(domain)?.finalUrl ?? `https://${domain}/`).origin;
  try {
    const rb = await get(`${origin}/robots.txt`);
    if (rb.ok && !robotsAllows(rb.body, "/about")) return null;
  } catch { /* no robots */ }
  for (const p of ["/about", "/about-us", "/company", "/who-we-are"]) {
    try {
      const r = await get(origin + p);
      if (!r.ok || !/html/i.test(r.type)) continue;
      const page = parsePage(r.body);
      if (page.text.length < 200 || looksParked(page)) continue;
      return { domain, url: r.url, text: [page.description, page.text].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 1200), fetchedAt: new Date().toISOString() };
    } catch { /* try next */ }
  }
  return null;
}

const out = fs.createWriteStream(OUT, { flags: "a" });
let cursor = 0, finished = 0, found = 0;
async function worker() {
  while (cursor < todo.length) {
    const d = todo[cursor++];
    const a = await aboutFor(d).catch(() => null);
    // A miss is recorded too (empty text) so the domain is not retried on resume.
    out.write(JSON.stringify(a ?? { domain: d, url: "", text: "", fetchedAt: new Date().toISOString() }) + "\n");
    if (a) found++;
    if (++finished % 200 === 0) console.log(`${finished}/${todo.length} (about pages found ${found})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await new Promise((r) => out.end(r));
console.log(`done: ${finished} fetched, ${found} About pages read`);
