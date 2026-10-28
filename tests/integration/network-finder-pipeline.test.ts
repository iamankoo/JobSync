/**
 * Network Finder end to end with MOCK providers, saving through the REAL existing Connections and Jobs
 * services into the in-memory test spreadsheet (FakeSheets). No network, no real accounts, no production.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { createConnection } from "@/lib/google-sheets/connections-service";
import { createJob } from "@/lib/google-sheets/jobs-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { ApolloPool, InMemoryApolloUsageStore, loadApolloAccounts } from "@/lib/network-finder/apollo-pool";
import { loadNetworkFinderConfig, type NetworkFinderConfig } from "@/lib/network-finder/config";
import { ProviderError } from "@/lib/network-finder/errors";
import { existingConnections, existingJobs } from "@/lib/network-finder/gateways";
import { processCompany, recheckCompanyJobs, runBatchTick, runDailyJobSearch, type CompanyTask, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { apolloProvider, careersJobSource, wellfoundSource, ycSource } from "@/lib/network-finder/providers/unconnected";
import { qualifyCompany } from "@/lib/network-finder/qualify";
import { InMemoryQueue } from "@/lib/network-finder/queue";
import { InMemoryCompanyRegistry } from "@/lib/network-finder/registry";
import { InMemoryBatchLedger } from "@/lib/network-finder/scheduler";
import type { CompanyCandidate, QualifiedCompany } from "@/lib/network-finder/types";
import { FakeSheets, googleError } from "../helpers/fake-sheets";
import { MockApollo, mockCompany, MockCompanySource, mockJob, MockJobSource } from "../helpers/network-finder-mocks";

// Connections columns: 0 ID 1 MemberID 2 Name 3 Company 4 Role 5 ProfileUrl 6 OtherUrl 7 Message 8 Notes 9 Status 10 CreatedAt 11 UpdatedAt 12 Email
// Jobs columns: 0 ID 1 Company 2 JobRole 3 JobType 4 WorkMode 5 Experience 6 Stipend 7 Location 8 JobURL 9 Deadline 10 Description 11 AddedBy 12 AddedAt

let sheets: FakeSheets;
let clock: number;
/** 10:30 in Asia/Kolkata on 27 Oct 2026 = inside batch window #2 (10 AM–12 PM). */
const IN_WINDOW = Date.UTC(2026, 9, 27, 5, 0);

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  clock = IN_WINDOW;
});
afterEach(() => setSheetsClientForTesting(null));

const conns = () => sheets.dataRows("Connections");
const jobs = () => sheets.dataRows("Jobs");

function setup(options: { companies?: CompanyCandidate[]; apolloKeys?: number; dailyLimit?: number; config?: Partial<NetworkFinderConfig> } = {}) {
  const apolloEnv = {
    ...Object.fromEntries(Array.from({ length: options.apolloKeys ?? 2 }, (_, i) => [`APOLLO_API_KEY_${i + 1}`, `mock-key-${i + 1}`])),
    APOLLO_DAILY_LIMIT: String(options.dailyLimit ?? 500),
    APOLLO_PER_MINUTE_LIMIT: "500",
  } as unknown as NodeJS.ProcessEnv;
  const source = new MockCompanySource("yc", options.companies ?? [mockCompany(1)]);
  const apollo = new MockApollo();
  const jobSource = new MockJobSource();
  const deps: PipelineDeps = {
    config: { ...loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv), maxCompaniesPerTick: 10, ...options.config },
    sources: [source],
    contacts: apollo,
    jobSources: [jobSource],
    pool: new ApolloPool(loadApolloAccounts(apolloEnv), new InMemoryApolloUsageStore(), () => clock),
    queue: new InMemoryQueue<CompanyTask>(),
    registry: new InMemoryCompanyRegistry(),
    ledger: new InMemoryBatchLedger(),
    connections: existingConnections,
    jobs: existingJobs,
    now: () => new Date(clock),
  };
  return { deps, source, apollo, jobSource };
}

const q = (c: CompanyCandidate): QualifiedCompany => {
  const r = qualifyCompany(c);
  if (!r.qualified) throw new Error(r.reason);
  return r.company;
};

describe("the complete mocked flow", () => {
  it("company → qualify → 3 people → enrich → de-duplicate → Connections → job → Jobs (as Anni)", async () => {
    const { deps, apollo, jobSource } = setup();
    const company = q(mockCompany(1));
    jobSource.byCompany.set(company.key, [
      mockJob(company.name, 1), // relevant new-grad role
      mockJob(company.name, 2, { title: "Senior Staff Engineer" }), // not for freshers
      mockJob(company.name, 3, { title: "Account Executive" }), // not a target profile
    ]);

    const tick = await runBatchTick(deps);
    expect(tick.ran).toBe(true);
    if (!tick.ran) return;
    expect(tick.discovery?.enqueued.map((c) => c.key)).toEqual([company.key]);
    const [out] = tick.processed;

    // Three people, in priority order: recruiter, hiring manager, founder. Sales person ignored.
    expect(out.contactsSaved).toEqual(["Riya Talent mock1", "Alex Manager mock1", "Sam Founder mock1"]);
    expect(out.contactsSkipped).toContainEqual({ name: "Pat Sales mock1", reason: "role not relevant" });
    // One search + exactly three enrichments: nobody beyond the target was enriched (credits saved).
    expect(apollo.calls.map((c) => c.op)).toEqual(["search", "enrich", "enrich", "enrich"]);

    // Saved through the existing Connections service: shared list, added by Anni, Not Connected, no message.
    expect(conns()).toHaveLength(3);
    const riya = conns().find((r) => r[2] === "Riya Talent mock1")!;
    expect(riya[1]).toBe("anni");
    expect(riya.slice(3, 7)).toEqual(["Mock Startup 1", "Technical Recruiter", "https://www.linkedin.com/in/riya-mock1", "https://mock1.example.test"]);
    expect(riya[7]).toBe(""); // "Message to send" untouched
    expect(riya[9]).toBe("Not Connected");
    expect(riya[12]).toBe("riya@mock1.example.test");
    expect(riya[8]).toContain("Source: Network Finder — YC (https://directory.example.test/companies/1) → apollo");
    expect(riya[8]).toContain("Discovered: 2026-10-27");
    expect(riya[8]).toContain("Type: Recruiter / Talent");

    // Only the relevant posting went to Jobs, through the existing Jobs service, added by Anni.
    expect(out.jobsSaved).toEqual(["Software Engineer, New Grad"]);
    expect(out.jobsSkipped.map((s) => s.name)).toEqual(["Senior Staff Engineer", "Account Executive"]);
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0].slice(1, 5)).toEqual(["Mock Startup 1", "Software Engineer, New Grad", "Full-time", "Remote"]);
    expect(jobs()[0][7]).toBe("Remote (US)");
    expect(jobs()[0][10]).toContain("Found by Network Finder via mock-careers on 2026-10-27.");
    expect(jobs()[0][11]).toBe("anni");

    // Source record for the company, and the batch counter.
    expect(await deps.registry.get(company.key)).toMatchObject({ status: "processed", source: "yc", sourceId: "yc-1", contactsSaved: 3, jobsSaved: 1, country: "US", sizeTier: 25 });
    expect(await deps.ledger.get("2026-10-27#2")).toBe(1);
  });

  it("is safe to run again: the same company found again adds no contacts or jobs", async () => {
    const { deps, jobSource } = setup();
    const company = q(mockCompany(1));
    jobSource.byCompany.set(company.key, [mockJob(company.name, 1)]);
    await runBatchTick(deps);
    const second = await runBatchTick(deps);
    expect(second.ran && second.discovery?.alreadyKnown).toBe(1);
    expect(second.ran && second.processed).toEqual([]);
    clock += 24 * 3_600_000; // next day, the source still lists it
    await runBatchTick(deps);
    expect(conns()).toHaveLength(3);
    expect(jobs()).toHaveLength(1);
  });

  it("processing the same company twice (a retry) tops up to 3 people, never duplicates, and spends no extra credits", async () => {
    const { deps, apollo } = setup();
    const company = q(mockCompany(1));
    await processCompany(deps, company);
    apollo.calls = [];
    const again = await processCompany(deps, company);
    expect(again.contactsSaved).toEqual([]);
    expect(apollo.enrichCalls()).toHaveLength(0);
    expect(conns()).toHaveLength(3);
  });
});

describe("de-duplication against what the team already has", () => {
  it("skips a person already in Connections by email, profile URL, or name + company — including manual entries", async () => {
    const { deps, apollo } = setup();
    const company = q(mockCompany(1));
    // Lukky already added two of these people by hand.
    await createConnection("lukky", { name: "R. Talent", email: "RIYA@mock1.example.test", status: "Messaged" });
    await createConnection("lukky", { name: "Sam", profileUrl: "https://linkedin.com/in/sam-mock1/", status: "Connected" });
    const out = await processCompany(deps, company);
    expect(out.contactsSkipped).toEqual(expect.arrayContaining([
      { name: "Riya Talent mock1", reason: "already in Connections (email)" },
      { name: "Sam Founder mock1", reason: "already in Connections (profile_url)" },
    ]));
    // Sam was recognised from the profile URL BEFORE enrichment: no credit spent on him.
    expect(apollo.enrichCalls().map((c) => c.who)).not.toContain("Sam Founder mock1");
    // Known people count toward the 3, so only Alex is new; the manual rows are untouched.
    expect(out.contactsSaved).toEqual(["Alex Manager mock1"]);
    expect(conns()).toHaveLength(3);
    expect(conns().filter((r) => r[1] === "lukky").map((r) => r[9])).toEqual(["Messaged", "Connected"]);
  });

  it("skips a posting already in Jobs (added manually, at a tracking-tagged URL)", async () => {
    const { deps, jobSource } = setup();
    const company = q(mockCompany(1));
    const job = mockJob(company.name, 1);
    await createJob("lukky", { company: company.name, jobRole: job.title, jobType: "Full-time", location: "Remote", jobUrl: `${job.url}?utm_source=linkedin` });
    jobSource.byCompany.set(company.key, [job]);
    const out = await processCompany(deps, company);
    expect(out.jobsSkipped).toEqual([{ name: job.title, reason: "already in Jobs (url)" }]);
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0][11]).toBe("lukky");
  });
});

describe("Apollo limits: pause, preserve progress, resume without duplicates", () => {
  it("rotates to the next account when one is rate-limited, without exposing keys", async () => {
    const { deps, apollo } = setup({ apolloKeys: 2 });
    apollo.failures.set("mock-key-1", new ProviderError("apollo", "rate_limited", "slow down", clock + 60_000));
    const tick = await runBatchTick(deps);
    expect(tick.ran && tick.processed[0].contactsSaved).toHaveLength(3);
    expect(apollo.calls.filter((c) => c.apiKey === "mock-key-2")).toHaveLength(4);
    expect(JSON.stringify(tick)).not.toContain("mock-key");
    expect((await deps.pool!.status()).find((s) => s.id === "apollo-1")).toMatchObject({ pauseReason: "rate_limited" });
  });

  it("Apollo is optional: running out mid-company never pauses the batch — the company finishes with what was found", async () => {
    // One account, 3 calls a day: search + 2 enrichments, then out of quota.
    const { deps, apollo } = setup({ apolloKeys: 1, dailyLimit: 3 });
    const company = q(mockCompany(1));
    const first = await runBatchTick(deps);
    expect(first.ran && first.pausedUntil).toBeUndefined();
    expect(first.ran && first.processed[0].warnings.some((w) => /apollo: all accounts exhausted — continuing with free sources/.test(w))).toBe(true);
    // Riya + Alex enriched; Sam could not be enriched but is still reachable through his public profile URL.
    expect(conns().map((r) => [r[2], r[12]])).toEqual([["Riya Talent mock1", "riya@mock1.example.test"], ["Alex Manager mock1", "alex@mock1.example.test"], ["Sam Founder mock1", ""]]);
    expect(await deps.queue.get(`company:${company.key}`)).toMatchObject({ status: "done" });
    expect(apollo.calls).toHaveLength(3); // never asked again once exhausted
    expect(await deps.queue.state(clock)).toMatchObject({ paused: false });
  });
});

describe("failures never produce made-up data", () => {
  it("with the real (not yet connected) adapters, nothing is discovered and nothing is written", async () => {
    const { deps } = setup();
    deps.sources = [ycSource, wellfoundSource];
    deps.contacts = apolloProvider;
    deps.jobSources = [careersJobSource];
    const tick = await runBatchTick(deps);
    expect(tick.ran && tick.discovery?.errors).toEqual(["yc: not_configured", "wellfound: not_configured"]);
    expect(tick.ran && tick.processed).toEqual([]);
    expect(sheets.calls.filter((c) => c.op !== "get")).toEqual([]);
  });

  it("a job source being down does not stop the contacts, and is reported", async () => {
    const { deps, jobSource } = setup();
    jobSource.failWith = new ProviderError("mock-careers", "unavailable", "down");
    const out = await processCompany(deps, q(mockCompany(1)));
    expect(out.contactsSaved).toHaveLength(3);
    expect(out.warnings).toEqual(["mock-careers: unavailable"]);
    expect(jobs()).toHaveLength(0);
  });

  it("a spreadsheet error while saving retries the company later, with no duplicates", async () => {
    const { deps } = setup();
    const company = q(mockCompany(1));
    sheets.failNext = { op: "append", error: googleError(500) };
    const first = await runBatchTick(deps);
    expect(first.ran && first.processed).toEqual([]);
    expect(await deps.queue.get(`company:${company.key}`)).toMatchObject({ status: "pending", attempts: 1 });
    clock += 2 * 60_000; // past the 1-minute backoff, still in the window
    await runBatchTick(deps);
    expect(conns()).toHaveLength(3);
  });
});

describe("re-checking known companies and the daily job search", () => {
  it("re-checks processed companies for NEW openings only, no Apollo credits, no duplicates", async () => {
    const { deps, apollo, jobSource } = setup();
    const company = q(mockCompany(1));
    jobSource.byCompany.set(company.key, [mockJob(company.name, 1)]);
    await runBatchTick(deps);
    apollo.calls = [];
    expect((await recheckCompanyJobs(deps, 10)).checked).toBe(0); // checked moments ago
    clock += 25 * 3_600_000;
    jobSource.byCompany.set(company.key, [mockJob(company.name, 1), mockJob(company.name, 2, { title: "Data Analyst Intern" })]);
    const re = await recheckCompanyJobs(deps, 10);
    expect(re).toMatchObject({ checked: 1, jobsSaved: ["Data Analyst Intern"] });
    expect(apollo.calls).toEqual([]);
    expect(jobs().map((j) => j[2])).toEqual(["Software Engineer, New Grad", "Data Analyst Intern"]);
    clock += 25 * 3_600_000;
    expect((await recheckCompanyJobs(deps, 10)).jobsSaved).toEqual([]);
    expect(jobs()).toHaveLength(2);
  });

  it("one opening per company, best matches only, never more than a day's quota (full rules: network-finder-daily-jobs.test.ts)", async () => {
    const { deps, jobSource } = setup();
    const eligible = { description: "New grads welcome. React and Node.js services.", salary: { max: 1_500_000, currency: "INR", period: "year" as const }, workplace: "remote" as const };
    jobSource.searchResults = [
      ...Array.from({ length: 4 }, (_, i) => mockJob(`FT Co ${i}`, 300 + i, { title: "Junior Backend Engineer", source: "Greenhouse", ...eligible })),
      mockJob("FT Co 0", 350, { title: "Backend Engineer, New Grad", source: "Greenhouse", ...eligible }), // same company again
      mockJob("FT Co 9", 400, { title: "Senior Backend Engineer", source: "Greenhouse", ...eligible }), // not for freshers
      mockJob("FT Co 8", 401, { title: "Sales Manager", source: "Greenhouse", ...eligible }), // not a target profile
    ];
    const day = await runDailyJobSearch(deps);
    expect(day.fullTime).toHaveLength(4);
    expect(new Set(jobs().map((j) => j[1])).size).toBe(4);
    expect(jobs().some((j) => /Senior|Sales/.test(j[2]))).toBe(false);
    expect(await runDailyJobSearch(deps)).toMatchObject({ internships: [], fullTime: [] });
    expect(jobs()).toHaveLength(4);
  });
});

describe("batch scheduling", () => {
  it("does nothing when disabled or outside the five windows", async () => {
    const off = setup({ config: { enabled: false } });
    expect(await runBatchTick(off.deps)).toEqual({ ran: false, reason: "disabled" });
    const { deps, source, apollo } = setup();
    clock = Date.UTC(2026, 9, 27, 7, 0); // 12:30 IST, between windows
    expect(await runBatchTick(deps)).toEqual({ ran: false, reason: "outside_window" });
    expect(source.calls).toEqual([]);
    expect(apollo.calls).toEqual([]);
  });

  it("fills a window with 10 companies (about 7 US / 3 international), then stops", async () => {
    const companies = [
      ...Array.from({ length: 10 }, (_, i) => mockCompany(i + 1, { countryCode: "US" })),
      ...Array.from({ length: 10 }, (_, i) => mockCompany(i + 101, { countryCode: i % 2 ? "GB" : "SG", sourceId: `yc-${i + 101}` })),
    ];
    const { deps } = setup({ companies, config: { maxCompaniesPerTick: 4 } });
    const ticks = [];
    for (let i = 0; i < 4; i++) ticks.push(await runBatchTick(deps));
    expect(ticks[3]).toEqual({ ran: false, reason: "batch_complete" });
    expect(await deps.ledger.get("2026-10-27#2")).toBe(10);
    const records = await deps.registry.all();
    expect(records.filter((r) => r.status === "processed").length).toBe(10);
    expect(records.filter((r) => r.country === "US")).toHaveLength(7);
    expect(records.filter((r) => r.country !== "US")).toHaveLength(3);
    expect(conns()).toHaveLength(30);
  });
});
