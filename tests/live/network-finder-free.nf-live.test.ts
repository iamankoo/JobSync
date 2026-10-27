/**
 * LIVE, SMALL: the FREE Network Finder against REAL public sources (HN "Who is hiring?" API, the companies' own
 * public websites, public job-board APIs) and REAL Nemotron, for at most 3 companies.
 *  - writes ONLY to an in-memory spreadsheet through the existing Connections / Jobs services (never production);
 *  - Gmail is NOT contacted (no OAuth client configured): drafts are written by Nemotron into in-memory mailboxes;
 *  - Apollo: account 1 only, optional, at most 3 organization-enrich calls; never the other accounts;
 *  - never prints a key; robots.txt respected; 1 request/second per site; real people appear as initials only.
 * Opt-in: npx vitest run --config vitest.network-finder-live.config.mts tests/live/network-finder-free.nf-live.test.ts
 */
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { ApolloPool, InMemoryApolloUsageStore, loadApolloAccounts } from "@/lib/network-finder/apollo-pool";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { InMemorySelectionStore } from "@/lib/network-finder/distribution";
import { existingConnections, existingJobs } from "@/lib/network-finder/gateways";
import { PoliteFetcher } from "@/lib/network-finder/http/polite-fetch";
import { processCompany, runDailyJobSearch, type CompanyTask, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { createApolloOrgProvider } from "@/lib/network-finder/providers/apollo-org";
import { createArbeitnowSource, createCompanyBoardSource, createRemoteOkSource } from "@/lib/network-finder/providers/job-boards";
import { createCompanyFactsFinder } from "@/lib/network-finder/providers/company-facts";
import { createNemotronBrain, createNemotronCompanyFactsExtractor, createNemotronPeopleExtractor, loadNemotronConfig } from "@/lib/network-finder/providers/nemotron";
import { createHnHiringSource } from "@/lib/network-finder/providers/public-sources";
import { createWebsiteContactFinder } from "@/lib/network-finder/providers/website-contacts";
import { qualifyCompany } from "@/lib/network-finder/qualify";
import { InMemoryQueue } from "@/lib/network-finder/queue";
import { InMemoryCompanyRegistry } from "@/lib/network-finder/registry";
import { InMemoryBatchLedger } from "@/lib/network-finder/scheduler";
import type { CompanyCandidate, QualifiedCompany } from "@/lib/network-finder/types";
import { FakeSheets } from "../helpers/fake-sheets";
import { MockMailboxes, MockNotifier } from "../helpers/network-finder-mocks";

const local = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]),
);
const SECRETS = Object.entries(local).filter(([k, v]) => /KEY|SECRET|TOKEN/.test(k) && v.length > 8).map(([, v]) => v);
const logged: string[] = [];
const log = (label: string, value: unknown) => {
  const line = `NF-FREE-LIVE ${label}: ${typeof value === "string" ? value : JSON.stringify(value, null, 1)}`;
  logged.push(line);
  console.log(line);
};
const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("");
const MAX_COMPANIES = 3;
const SITES_TO_TRY = 8;

let sheets: FakeSheets;
const counts = { nemotron: 0, apollo: 0 };
const countingFetch = (kind: keyof typeof counts) => async (url: string, init?: RequestInit) => {
  counts[kind] += 1;
  return fetch(url, init);
};

beforeAll(() => {
  sheets = new FakeSheets().seedMembers(); // in-memory only: production is unreachable from this file
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterAll(() => {
  setSheetsClientForTesting(null);
  for (const s of SECRETS) expect(logged.join("\n")).not.toContain(s);
});

const fetcher = new PoliteFetcher();
const nemo = loadNemotronConfig({ NEMOTRON_API_KEY: local.NEMOTRON_API_KEY, NEMOTRON_MODEL: local.NEMOTRON_MODEL } as unknown as NodeJS.ProcessEnv)!;
// Apollo account 1 ONLY, hard ceiling of 3 calls for this whole run (organization enrich works on the Free plan).
const pool = new ApolloPool(loadApolloAccounts({ APOLLO_API_KEY_1: local.APOLLO_API_KEY_1, APOLLO_DAILY_LIMIT: "3", APOLLO_PER_MINUTE_LIMIT: "3" } as unknown as NodeJS.ProcessEnv), new InMemoryApolloUsageStore());
const org = createApolloOrgProvider(pool, countingFetch("apollo"));
const mail = new MockMailboxes();
const finder = createWebsiteContactFinder(fetcher, createNemotronPeopleExtractor(nemo, countingFetch("nemotron")));
const deps: PipelineDeps = {
  config: { ...loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv) },
  sources: [],
  contactFinders: [finder],
  brain: createNemotronBrain(nemo, countingFetch("nemotron"), (m) => log("nemotron fallback", m)),
  jobSources: [createCompanyBoardSource(fetcher), createRemoteOkSource(fetcher), createArbeitnowSource(fetcher)],
  queue: new InMemoryQueue<CompanyTask>(),
  registry: new InMemoryCompanyRegistry(),
  ledger: new InMemoryBatchLedger(),
  selections: new InMemorySelectionStore(),
  drafts: mail,
  notifier: new MockNotifier(),
  connections: existingConnections,
  jobs: existingJobs,
  runState: {},
};
let candidates: CompanyCandidate[] = [];
const withPeople: CompanyCandidate[] = [];
const picked: QualifiedCompany[] = [];

const provisional = (c: CompanyCandidate) => ({ ...c, key: `domain:${new URL(c.website!).hostname}`, domain: new URL(c.website!).hostname.replace(/^www\./, ""), country: "US", regionGroup: "us", sizeTier: 250, score: 0, reasons: [] }) as QualifiedCompany;

describe("free discovery (real HN API + company websites)", () => {
  it("reads the current 'Who is hiring?' thread; qualification uses stated facts only", async () => {
    candidates = (await createHnHiringSource(fetcher).discover({ maxEmployees: 250, countries: [], limit: 40 })).companies;
    const reasons: Record<string, number> = {};
    for (const c of candidates) {
      const q = qualifyCompany(c);
      const r = q.qualified ? "qualified" : q.reason.replace(/\d+/g, "N");
      reasons[r] = (reasons[r] ?? 0) + 1;
    }
    log("HN posts parsed into companies", candidates.length);
    log("qualification from the posts alone", reasons);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("free size / country from the companies' own pages (≤6 sites, rules + Nemotron, re-checked; no Apollo)", async () => {
    const facts = createCompanyFactsFinder(fetcher, createNemotronCompanyFactsExtractor(nemo, countingFetch("nemotron")));
    const tally: Record<string, number> = {};
    for (const c of candidates.filter((x) => x.website && (x.employeeCount === undefined || !x.countryCode)).slice(0, 6)) {
      try {
        const f = await facts.find(c);
        const merged = f ? { ...c, ...(c.employeeCount === undefined && f.employeeCount !== undefined ? { employeeCount: f.employeeCount } : {}), ...(!c.countryCode && f.countryCode ? { countryCode: f.countryCode } : {}) } : c;
        const q = qualifyCompany(merged);
        const r = q.qualified ? `qualified (≤${q.company.sizeTier}, ${q.company.country})` : q.reason.replace(/\d+/g, "N");
        tally[r] = (tally[r] ?? 0) + 1;
        log(`facts ${c.name}`, f ? `${f.employeeCount ?? "?"} employees, ${f.countryCode ?? "?"} — ${f.source}` : "pages do not state size/location");
      } catch (err) {
        log(`facts ${c.name}`, `skipped (${(err as { kind?: string }).kind ?? (err as Error).name})`);
      }
    }
    log("qualification after the free website step", tally);
  });

  it(`reads up to ${SITES_TO_TRY} company websites (read-only) to see which publicly name people`, async () => {
    for (const c of candidates.filter((x) => x.website).slice(0, SITES_TO_TRY)) {
      try {
        const f = await finder.findPeople(provisional(c));
        log(`site ${c.name}`, { pagesRead: f.pages.length, peopleWithTitles: f.people.map((p) => `${initials(p.name)} — ${p.title}${p.email ? " (public email)" : ""}${p.linkedinUrl ? " (LinkedIn)" : ""}`), addressesOnDomain: f.publishedEmails.length });
        if (f.people.length) withPeople.push(c);
      } catch (err) {
        log(`site ${c.name}`, `skipped (${(err as { kind?: string }).kind ?? (err as Error).name})`);
      }
    }
  });

  it("fills missing size/country from Apollo organization enrich (account 1, ≤3 calls) — only for sites that name people", async () => {
    for (const c of withPeople.slice(0, 3)) {
      try {
        const e = await org.enrichByDomain(new URL(c.website!).hostname.replace(/^www\./, ""), "hn", c.sourceUrl);
        const merged = { ...c, ...(c.employeeCount === undefined && e?.employeeCount !== undefined ? { employeeCount: e.employeeCount } : {}), ...(!c.countryCode && e?.countryCode ? { countryCode: e.countryCode } : {}) };
        const q = qualifyCompany(merged);
        log(`enrich ${c.name}`, q.qualified ? `qualified (${q.company.employeeCount} employees, ${q.company.country}, tier ≤${q.company.sizeTier})` : `not qualified — ${q.reason}`);
        if (q.qualified && picked.length < MAX_COMPANIES) picked.push(q.company);
      } catch (err) {
        log(`enrich ${c.name}`, `unavailable (${(err as { kind?: string }).kind ?? (err as Error).name})`);
      }
    }
  });
});

describe(`pipeline for ≤${MAX_COMPANIES} real companies (in-memory sheet, in-memory mailboxes)`, () => {
  it("contacts → dedupe → Connections (as Anni) → selection (17/17/16 order) → Nemotron drafts for all three", async () => {
    for (const company of picked) {
      const out = await processCompany(deps, company);
      log(`company ${company.name}`, {
        peopleFound: out.peopleFound,
        contactsSaved: out.contactsSaved.map(initials),
        skipped: out.contactsSkipped.map((s) => `${initials(s.name)}: ${s.reason}`),
        selected: out.selected ? { who: initials(out.selected.name), assignedTo: out.selected.assignedTo, emailStatus: out.selected.emailStatus } : "none (no reachable contact)",
        drafts: out.drafts?.map((d) => `${d.memberId}:${d.result}${d.detail ? ` (${d.detail})` : ""}`),
        jobsSaved: out.jobsSaved,
        warnings: out.warnings,
      });
    }
    const rows = sheets.dataRows("Connections");
    log("Connections rows (in memory)", rows.map((r) => ({ who: initials(r[2]), company: r[3], role: r[4], owner: r[1], status: r[9], message: r[7] ? "SET" : "(empty)", email: r[12] ? "yes" : "no", emailNote: r[8].split("\n").find((l) => l.startsWith("Email:"))?.replace(/[\w.+-]+@[\w.-]+/g, "<addr>"), assigned: r[8].split("\n").find((l) => l.startsWith("Assigned to:")) ?? "" })));
    expect(rows.every((r) => r[1] === "anni" && r[9] === "Not Connected" && r[7] === "")).toBe(true);
    for (const d of mail.drafts) log(`draft in ${d.memberId}'s mailbox`, { to: d.to ? "(contact address)" : "(none)", subject: d.subject, words: d.body.split(/\s+/).length, signedByMember: d.body.includes(d.memberId === "anni" ? "Anni" : d.memberId === "lukky" ? "Lukky" : "Rishii"), placeholders: /\[[A-Z][A-Za-z ]+\]/.test(d.body) });
    expect(mail.drafts.every((d) => !/\[[A-Z][A-Za-z ]+\]/.test(d.body))).toBe(true);
  });

  it("daily job search from public APIs (Remote OK, Arbeitnow) into Jobs as Anni", async () => {
    const r = await runDailyJobSearch(deps);
    log("daily job search", r);
    log("Jobs rows (in memory)", sheets.dataRows("Jobs").map((j) => `${j[3]} | ${j[2]} @ ${j[1]} | ${j[4] || "—"} | addedBy=${j[11]}`));
    expect(sheets.dataRows("Jobs").every((j) => j[11] === "anni")).toBe(true);
  });

  it("reports every external request made", () => {
    const hosts = fetcher.log.reduce<Record<string, number>>((a, u) => ((a[new URL(u).host] = (a[new URL(u).host] ?? 0) + 1), a), {});
    log("public web/API requests by host", hosts);
    log("public web/API requests total", fetcher.log.length);
    log("nemotron requests", counts.nemotron);
    log("apollo requests (account 1)", counts.apollo);
    log("gmail requests", 0);
  });
});
