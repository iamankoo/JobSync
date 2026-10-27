/**
 * LIVE: real Apollo (account 1 only, ≤5 calls) + real Nemotron, saving into an IN-MEMORY spreadsheet through the
 * existing Jobs service. Never touches production, never sends anything, never prints a key.
 * Company/person inputs to the brain are SYNTHETIC (clearly named) because Apollo's Free plan cannot discover them.
 */
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { ApolloPool, InMemoryApolloUsageStore, loadApolloAccounts } from "@/lib/network-finder/apollo-pool";
import { existingJobs } from "@/lib/network-finder/gateways";
import { toJobInput } from "@/lib/network-finder/mapping";
import { createApolloOrgProvider } from "@/lib/network-finder/providers/apollo-org";
import { createApolloProvider } from "@/lib/network-finder/providers/apollo";
import { createNemotronBrain, loadNemotronConfig } from "@/lib/network-finder/providers/nemotron";
import { qualifyCompany } from "@/lib/network-finder/qualify";
import type { JobCandidate, PersonCandidate, QualifiedCompany } from "@/lib/network-finder/types";
import { FakeSheets } from "../helpers/fake-sheets";

const local = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]),
);
const SECRETS = [local.APOLLO_API_KEY_1, local.NEMOTRON_API_KEY].filter(Boolean) as string[];
const WORKING_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
const logged: string[] = [];
const log = (label: string, value: unknown) => {
  const line = `NF-LIVE ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
  logged.push(line);
  console.log(line);
};
let sheets: FakeSheets;

beforeAll(() => {
  // In-memory spreadsheet only: production is never reachable from this file.
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterAll(() => {
  setSheetsClientForTesting(null);
  // No credential may appear in anything this run printed.
  for (const s of SECRETS) expect(logged.join("\n")).not.toContain(s);
});

const nemotron = () => {
  const cfg = loadNemotronConfig({ NEMOTRON_API_KEY: local.NEMOTRON_API_KEY, NEMOTRON_MODEL: local.NEMOTRON_MODEL } as unknown as NodeJS.ProcessEnv);
  if (!cfg) throw new Error("NEMOTRON_API_KEY / NEMOTRON_MODEL missing in .env.local");
  const configuredOk = cfg.model.startsWith("nvidia/");
  log("nemotron model", configuredOk ? cfg.model : `${JSON.stringify(cfg.model)} is not a valid model ID → testing with ${WORKING_MODEL}`);
  const warnings: string[] = [];
  return { brain: createNemotronBrain({ ...cfg, model: configuredOk ? cfg.model : WORKING_MODEL }, fetch, (m) => warnings.push(m)), warnings };
};

/** Account 1 only, hard ceiling of 5 Apollo calls for this whole run. */
const pool = new ApolloPool(loadApolloAccounts({ APOLLO_API_KEY_1: local.APOLLO_API_KEY_1, APOLLO_DAILY_LIMIT: "5", APOLLO_PER_MINUTE_LIMIT: "5" } as unknown as NodeJS.ProcessEnv), new InMemoryApolloUsageStore());

const synthetic = (n: number, over: Partial<Parameters<typeof qualifyCompany>[0]>): QualifiedCompany => {
  const q = qualifyCompany({ source: "manual", sourceId: `synthetic-${n}`, name: `Synthetic Startup ${n}`, website: `https://synthetic${n}.example.test`, employeeCount: 12, countryCode: "US", ...over });
  if (!q.qualified) throw new Error(q.reason);
  return q.company;
};

describe("Apollo account 1 (real API)", () => {
  it("people search / enrichment are refused by the Free plan and reported as 'forbidden', not retried or faked", async () => {
    const apollo = createApolloProvider();
    const company = synthetic(1, { website: "https://vercel.com" });
    const err = await pool.call(1, (ctx) => apollo.searchPeople(company, { limit: 3 }, ctx)).catch((e) => e);
    log("people search", { kind: err?.kind, message: err?.message });
    expect(err?.kind).toBe("forbidden");
  });

  it("company enrich + job postings work and flow through Nemotron relevance into the existing Jobs service (in-memory)", async () => {
    const org = createApolloOrgProvider(pool);
    const enriched = await org.enrichByDomain("vercel.com");
    log("enrich vercel.com", { name: enriched?.name, employees: enriched?.employeeCount, country: enriched?.countryCode, hasApolloId: Boolean(enriched?.apolloOrgId) });
    expect(enriched?.apolloOrgId).toBeTruthy();
    const q = qualifyCompany(enriched!);
    log("qualifies for Network Finder (≤250, target country)?", q.qualified ? "yes" : `no — ${q.reason}`);
    // Used only to exercise the job path (it is above the 250-employee cap, so it would not be targeted).
    const company = { ...enriched!, key: "domain:vercel.com", domain: "vercel.com", country: "US", regionGroup: "us", sizeTier: 250, score: 0, reasons: [] } as QualifiedCompany;
    const postings: JobCandidate[] = await org.jobSource.findCompanyJobs(company);
    log("job postings returned", postings.length);
    expect(postings.length).toBeGreaterThan(0);

    const { brain, warnings } = nemotron();
    const verdicts = [];
    for (const job of postings.slice(0, 12)) verdicts.push({ job, ...(await brain.isRelevantJob(job)) });
    log("nemotron job relevance", verdicts.map((v) => `${v.relevant ? "✓" : "✗"} ${v.job.title} — ${v.reason}`));
    log("nemotron fallbacks used", warnings.length);

    const relevant = verdicts.filter((v) => v.relevant).map((v) => v.job);
    for (const job of relevant.slice(0, 3)) {
      const res = await existingJobs.create("anni", toJobInput(job, "2026-10-27"));
      log("saved via Jobs service", "created" in res ? `${job.title} (added by ${res.created.addedBy})` : `duplicate of ${res.duplicateOf}`);
    }
    log("in-memory Jobs rows", sheets.dataRows("Jobs").map((r) => `${r[2]} | ${r[3]} | ${r[7]} | addedBy=${r[11]}`));
    log("apollo usage (account 1)", await pool.status());
  });
});

describe("Nemotron brain (real API, synthetic inputs)", () => {
  it("company selection keeps the size tiers and 70/30 split", async () => {
    const { brain, warnings } = nemotron();
    const candidates = [
      ...Array.from({ length: 10 }, (_, i) => synthetic(i + 10, { employeeCount: i < 5 ? 15 : 90, remoteFriendly: i % 2 === 0, hiring: i % 3 !== 0, description: i % 2 ? "B2B analytics SaaS hiring junior data engineers" : "Payments infrastructure" })),
      ...Array.from({ length: 5 }, (_, i) => synthetic(i + 30, { countryCode: ["GB", "SG", "DE", "CA", "AE"][i], employeeCount: 20, remoteFriendly: true, hiring: true, description: "AI tooling startup, hiring new grads" })),
    ];
    const picked = await brain.prioritizeCompanies(candidates, 10);
    log("selected", picked.map((c) => `${c.name} (${c.country}, ≤${c.sizeTier}, score ${c.score})`));
    log("fallbacks used", warnings.length);
    expect(picked).toHaveLength(10);
    expect(picked.filter((c) => c.country === "US")).toHaveLength(7);
    expect(picked.every((p) => candidates.some((c) => c.key === p.key))).toBe(true);
  });

  it("job relevance on common titles (no Apollo credits)", async () => {
    const { brain } = nemotron();
    const titles: [string, boolean][] = [
      ["Software Engineer, Agentic Infrastructure", true], ["Member of Technical Staff, Finance Data", true], ["Data Analyst Intern", true],
      ["Junior Backend Engineer (Remote)", true], ["Machine Learning Engineer, New Grad", true], ["Frontend Developer", true],
      ["Engineering Director, Platforms", false], ["Senior Staff Software Engineer", false], ["Account Executive, Commercial Germany", false], ["Customer Support Engineer", false], ["Product Manager, Storage", false],
    ];
    const results = [];
    for (const [title, expected] of titles) {
      const v = await brain.isRelevantJob({ source: "live-check", companyName: "Synthetic", title, url: "https://jobs.example.test/x" });
      results.push({ title, expected, got: v.relevant, reason: v.reason });
    }
    log("job relevance check", results.map((r) => `${r.got === r.expected ? "OK " : "MISS"} ${r.got ? "✓" : "✗"} ${r.title}`));
    expect(results.filter((r) => r.got !== r.expected).length).toBeLessThanOrEqual(1);
  });

  it("contact prioritisation picks only from the given people, recruiters/hiring managers first", async () => {
    const { brain } = nemotron();
    const people: PersonCandidate[] = ["Account Executive", "Software Engineer", "Co-Founder & CEO", "Technical Recruiter", "Engineering Manager", "Office Manager"].map((title, i) => ({ provider: "apollo", providerId: `p${i}`, name: `Synthetic Person ${i}`, title, companyName: "Synthetic Startup" }));
    const chosen = await brain.choosePeople(synthetic(50, {}), people, 3);
    log("chosen", chosen.map((p) => p.title));
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.length).toBeLessThanOrEqual(3);
    expect(chosen.every((c) => people.includes(c))).toBe(true);
    expect(chosen[0].title).toBe("Technical Recruiter"); // priority order is enforced in code
  });

  it("writes a personalised draft per member (text only — nothing is sent)", async () => {
    const { brain } = nemotron();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const member of [{ id: "anni", name: "Anni" }, { id: "lukky", name: "Lukky" }, { id: "rishii", name: "Rishii" }]) {
      const d = await brain.writeDraft({ kind: "outreach", member, company: { name: "Synthetic Startup", description: "Developer tools for data pipelines" }, person: { name: "Priya Sharma", title: "Technical Recruiter" } });
      log(`draft for ${member.name}`, { subject: d.subject, words: d.body.split(/\s+/).length, signedAsMember: d.body.includes(member.name), preview: d.body.slice(0, 160) });
      expect(d.subject.length).toBeGreaterThan(0);
      expect(d.body).not.toMatch(/\[[A-Z][A-Za-z ]+\]/);
    }
    // Only NVIDIA was called: no email/Gmail endpoint at all.
    expect(fetchSpy.mock.calls.every(([u]) => String(u).startsWith("https://integrate.api.nvidia.com/"))).toBe(true);
    fetchSpy.mockRestore();
  });
});
