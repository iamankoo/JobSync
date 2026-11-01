/**
 * Progressive recency search over the REMAINING quota (1 Nov 2026 spec), end to end: mock job sources, the real Jobs service,
 * the in-memory test spreadsheet. A "scan" is one runDailyJobSearch call (one cron call). With 12 seeded boards a sweep of the
 * board list is exactly one scan, so each scan that leaves a kind's quota unmet opens that kind's next-older window.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { existingConnections, existingJobs, type JobsGateway } from "@/lib/network-finder/gateways";
import { jobLedgerKeys } from "@/lib/network-finder/job-allocation";
import { runDailyJobSearch, type CompanyTask, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { InMemoryQueue } from "@/lib/network-finder/queue";
import { InMemoryCompanyRegistry } from "@/lib/network-finder/registry";
import { InMemoryBatchLedger } from "@/lib/network-finder/scheduler";
import type { JobCandidate } from "@/lib/network-finder/types";
import { FakeSheets } from "../helpers/fake-sheets";
import { MockJobSource } from "../helpers/network-finder-mocks";

let sheets: FakeSheets;
const NOON_IST = Date.UTC(2026, 10, 1, 6, 30);
const DAY = "2026-11-01";
beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => setSheetsClientForTesting(null));

const jobs = () => sheets.dataRows("Jobs");
const SEEDS = Array.from({ length: 12 }, (_, i) => ({ name: `Board ${i}`, ats: "greenhouse" as const, token: `board${i}` }));

function setup(ledger = new InMemoryBatchLedger(), jobsGateway: JobsGateway = existingJobs) {
  const jobSource = new MockJobSource();
  const deps: PipelineDeps = {
    config: loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv),
    sources: [], jobSources: [jobSource], seedBoards: SEEDS,
    queue: new InMemoryQueue<CompanyTask>(), registry: new InMemoryCompanyRegistry(), ledger,
    connections: existingConnections, jobs: jobsGateway, now: () => new Date(NOON_IST),
  };
  return { deps, jobSource, ledger };
}

let seq = 0;
const STACK = "New grads welcome. B.Tech / B.E. students graduating in 2027. React, Node.js and Python.";
/** A fully eligible listing posted `age` days ago, in the given country group. */
function job(kind: "internship" | "full_time", age: number, region: "US" | "IN" | "OTHER", over: Partial<JobCandidate> = {}): JobCandidate {
  const n = ++seq;
  const intern = kind === "internship";
  return {
    source: "Greenhouse", companyName: `Co ${n}`, title: intern ? "Full Stack Engineering Intern" : "Full Stack Engineer, New Grad",
    url: `https://boards.greenhouse.io/co${n}/jobs/${n}`,
    location: region === "US" ? "Remote - Worldwide, United States" : region === "IN" ? "Bengaluru, India" : "Remote - Worldwide, Germany",
    remote: region !== "IN", workplace: region === "IN" ? "hybrid" : "remote",
    postedAt: new Date(NOON_IST - age * 86_400_000).toISOString(), description: STACK,
    salary: intern ? { max: 80_000, currency: "INR", period: "month" } : { max: 1_800_000, currency: "INR", period: "year" },
    ...(intern ? { employment: "internship" as const } : {}),
    ...over,
  };
}
/** `count` jobs of a kind, spread over the three country groups. */
const batch = (kind: "internship" | "full_time", age: number, count: number) => Array.from({ length: count }, (_, i) => job(kind, age, (["US", "IN", "OTHER"] as const)[i % 3]));
const total = (l: InMemoryBatchLedger, kind: "internship" | "full_time") => l.get(jobLedgerKeys(DAY, kind).total);
const rows = (type: "Internship" | "Full-time") => jobs().filter((r) => r[3] === type);
const searches = (s: MockJobSource, kind: string) => s.searches.filter((q) => q.employment === kind).length;

describe("search only for the remaining quota, newest window first", () => {
  it("Example A: 10 + 10 in the last 7 days; the next window finds only 5 more of each, then older windows are never opened", async () => {
    const { deps, jobSource, ledger } = setup();
    jobSource.searchResults = [...batch("internship", 3, 10), ...batch("full_time", 3, 10), ...batch("internship", 12, 9), ...batch("full_time", 12, 9), ...batch("internship", 25, 9), ...batch("full_time", 25, 9)];
    const first = await runDailyJobSearch(deps);
    expect(first.report!.internship).toMatchObject({ window: 2, saved: expect.any(Array) });
    expect(await total(ledger, "internship")).toBe(10); // window 1 only (the 8–15 and 16–30 day jobs waited)
    expect(await total(ledger, "full_time")).toBe(10);
    expect(first.report!.internship.deferred).toBe(18);
    expect(first.report!.internship.byWindow).toMatchObject({ 1: { eligible: 10, saved: 10 }, 2: { eligible: 9, saved: 0 }, 3: { eligible: 9, saved: 0 } });

    const second = await runDailyJobSearch(deps);
    expect(await total(ledger, "internship")).toBe(15);
    expect(await total(ledger, "full_time")).toBe(15);
    expect(second.report!.internship.saved).toHaveLength(5); // only the 5 still needed
    expect(second.report!.full_time.saved).toHaveLength(5);
    expect(second.report!.internship.byWindow[2].saved).toBe(5);
    expect(second.report!.internship.byWindow[3]?.saved ?? 0).toBe(0); // the 16–30 day jobs were not touched

    const before = jobSource.searches.length;
    await runDailyJobSearch(deps);
    expect(jobSource.searches.length).toBe(before); // both categories are complete: no search at all
    expect(jobs()).toHaveLength(30);
    for (const type of ["Internship", "Full-time"] as const) {
      const counts = rows(type).reduce<Record<string, number>>((m, r) => ({ ...m, [r[11]]: (m[r[11]] ?? 0) + 1 }), {});
      expect(counts).toEqual({ anni: 5, lukky: 5, rishii: 5 });
    }
  });

  it("Example B: 15 internships + 8 full-time in window 1; internships stop, full-time continues alone", async () => {
    const { deps, jobSource, ledger } = setup();
    jobSource.searchResults = [...batch("internship", 2, 15), ...batch("full_time", 2, 8), ...batch("full_time", 10, 10), ...batch("full_time", 40, 10), ...batch("internship", 10, 5)];
    await runDailyJobSearch(deps);
    expect(await total(ledger, "internship")).toBe(15);
    expect(await total(ledger, "full_time")).toBe(8);
    const internSearches = searches(jobSource, "internship");
    const second = await runDailyJobSearch(deps);
    expect(searches(jobSource, "internship")).toBe(internSearches); // stopped as soon as the target was reached
    expect(second.report!.internship).toBeUndefined();
    expect(second.report!.full_time.saved).toHaveLength(7); // only the 7 still missing
    expect(await total(ledger, "full_time")).toBe(15);
    expect(second.report!.full_time.byWindow[3]?.saved ?? 0).toBe(0); // the 31–60 day jobs were never reached
  });

  it("Example C: 10 internships + 15 full-time in window 1; the next window searches 5 internships only", async () => {
    const { deps, jobSource, ledger } = setup();
    jobSource.searchResults = [...batch("internship", 4, 10), ...batch("full_time", 4, 15), ...batch("internship", 9, 8), ...batch("full_time", 9, 8)];
    await runDailyJobSearch(deps);
    expect(await total(ledger, "internship")).toBe(10);
    expect(await total(ledger, "full_time")).toBe(15);
    const ftSearches = searches(jobSource, "full_time");
    const second = await runDailyJobSearch(deps);
    expect(searches(jobSource, "full_time")).toBe(ftSearches);
    expect(second.report!.internship.saved).toHaveLength(5);
    expect(await total(ledger, "internship")).toBe(15);
    expect(await total(ledger, "full_time")).toBe(15);
  });

  it("one category never starves the other: 40 internships available and only 5 full-time still gives 15 + 5", async () => {
    const { deps, jobSource, ledger } = setup();
    jobSource.searchResults = [...batch("internship", 1, 40), ...batch("full_time", 1, 5)];
    await runDailyJobSearch(deps);
    expect(await total(ledger, "internship")).toBe(15);
    expect(await total(ledger, "full_time")).toBe(5);
  });
});

describe("exhausting every window", () => {
  it("opens one window per unmet sweep (a job aged 91–120 days is taken only when window 6 opens), reports the exact shortfall, and stops at 120 days", async () => {
    const { deps, jobSource, ledger } = setup();
    const j100 = job("full_time", 100, "IN");
    const j118 = job("full_time", 118, "IN");
    jobSource.searchResults = [j100, j118, job("full_time", 121, "IN"), job("full_time", 300, "IN")];
    const windows: number[] = [];
    for (let scan = 1; scan <= 6; scan++) {
      const r = await runDailyJobSearch(deps);
      windows.push(r.report!.full_time.window);
      if (scan < 6) expect(await total(ledger, "full_time"), `scan ${scan}`).toBe(0); // not before its window is open
    }
    expect(windows).toEqual([2, 3, 4, 5, 6, 6]);
    expect(await total(ledger, "full_time")).toBe(2); // the two jobs aged 100 and 118 days; 121 and 300 are never taken
    expect(rows("Full-time").map((r) => r[8]).sort()).toEqual([j100.url, j118.url].sort());
    const last = await runDailyJobSearch(deps);
    expect(last.warnings.join()).toMatch(/window 6\/6 open; below target/);
    const note = JSON.parse((await ledger.getNote!(`${DAY}#funnel-full-time`))!);
    expect(note).toMatchObject({ w: 6, saved: 2 });
    expect(note.reasons["posted N days ago"]).toBeGreaterThan(0); // the older-than-120-day rejections are counted, with their reason
    expect(15 - (await total(ledger, "full_time"))).toBe(13); // the exact shortfall
  });

  it("undated listings are never saved, however many windows open", async () => {
    const { deps, jobSource, ledger } = setup();
    jobSource.searchResults = [job("full_time", 1, "IN", { postedAt: undefined }), job("full_time", 1, "US", { postedAt: "garbage" })];
    for (let i = 0; i < 7; i++) await runDailyJobSearch(deps);
    expect(await total(ledger, "full_time")).toBe(0);
  });
});

describe("duplicates and counting", () => {
  it("the same job returned by two sources counts once (the official source wins) and is not allocated twice", async () => {
    const { deps, jobSource } = setup();
    const official = job("full_time", 2, "IN", { companyName: "Dup Co", title: "Backend Engineer, New Grad" });
    const aggregator = { ...official, source: "Remote OK", url: "https://remoteok.com/remote-jobs/dup-1" };
    jobSource.searchResults = [aggregator, official];
    const r = await runDailyJobSearch(deps);
    expect(rows("Full-time")).toHaveLength(1);
    expect(rows("Full-time")[0][10]).toContain("via Greenhouse");
    expect(r.report!.full_time.parsed).toBe(1);
    expect(r.report!.full_time.reasons["same job returned by more than one source"]).toBe(1);
  });

  it("jobs already saved earlier today are not counted or allocated again on the next scan", async () => {
    const { deps, jobSource, ledger } = setup();
    jobSource.searchResults = batch("full_time", 2, 6);
    await runDailyJobSearch(deps);
    expect(await total(ledger, "full_time")).toBe(6);
    const again = await runDailyJobSearch(deps);
    expect(again.report!.full_time).toMatchObject({ duplicates: 6, allocated: 0 });
    expect(await total(ledger, "full_time")).toBe(6);
    expect(rows("Full-time")).toHaveLength(6);
  });

  it("the daily counters reset at local midnight and the next day starts again at window 1", async () => {
    const { deps, jobSource, ledger } = setup();
    jobSource.searchResults = [...batch("full_time", 2, 3), ...batch("full_time", 9, 3)];
    await runDailyJobSearch(deps);
    await runDailyJobSearch(deps);
    expect(await total(ledger, "full_time")).toBe(6);
    deps.now = () => new Date(NOON_IST + 24 * 3_600_000);
    jobSource.searchResults = batch("full_time", 1, 3);
    const next = await runDailyJobSearch(deps);
    expect(next.report!.full_time.window).toBe(2); // opened after this day's first unmet sweep: it started at window 1
    expect(await ledger.get(jobLedgerKeys("2026-11-02", "full_time").total)).toBe(3);
  });
});

describe("reliability: partial progress survives interruptions", () => {
  it("a run cut short keeps what it saved, repeats nothing, and a new process (same ledger) continues from the stored window", async () => {
    const ledger = new InMemoryBatchLedger();
    let creates = 0;
    const flaky: JobsGateway = { list: () => existingJobs.list(), create: async (o, i) => (++creates === 3 ? Promise.reject(new Error("socket hang up")) : existingJobs.create(o, i)) };
    const a = setup(ledger, flaky);
    a.jobSource.searchResults = batch("full_time", 2, 8);
    await expect(runDailyJobSearch(a.deps)).rejects.toThrow("socket hang up");
    expect(await total(ledger, "full_time")).toBe(2); // saved before the interruption, counted as it happened
    expect(rows("Full-time")).toHaveLength(2);
    const note = JSON.parse((await ledger.getNote!(`${DAY}#funnel-full-time`))!);
    expect(note.scans).toBe(1); // the scan itself was recorded

    // cron restarts: a fresh process, same durable ledger and sheet
    const b = setup(ledger);
    b.jobSource.searchResults = a.jobSource.searchResults;
    await runDailyJobSearch(b.deps);
    expect(await total(ledger, "full_time")).toBe(8);
    expect(rows("Full-time")).toHaveLength(8);
    expect(new Set(rows("Full-time").map((r) => r[8])).size).toBe(8); // no duplicates
    expect(JSON.parse((await ledger.getNote!(`${DAY}#funnel-full-time`))!).scans).toBe(2);
  });

  it("a source that fails or returns nothing neither burns a window sweep nor loses the day's work", async () => {
    const { deps, jobSource, ledger } = setup();
    jobSource.searchResults = [];
    for (let i = 0; i < 3; i++) await runDailyJobSearch(deps);
    const note = JSON.parse((await ledger.getNote!(`${DAY}#funnel-full-time`)) ?? "{}");
    expect(note.w ?? 1).toBe(1); // nothing was read, so no sweep was completed and no window opened
    jobSource.searchResults = batch("full_time", 2, 4);
    await runDailyJobSearch(deps);
    expect(await total(ledger, "full_time")).toBe(4);
  });

  it("an empty profile never changes eligibility: every member gets their 5 from the same pool", async () => {
    const { deps, jobSource } = setup();
    jobSource.searchResults = batch("full_time", 2, 15);
    await runDailyJobSearch(deps);
    const counts = rows("Full-time").reduce<Record<string, number>>((m, r) => ({ ...m, [r[11]]: (m[r[11]] ?? 0) + 1 }), {});
    expect(counts).toEqual({ anni: 5, lukky: 5, rishii: 5 });
  });
});
