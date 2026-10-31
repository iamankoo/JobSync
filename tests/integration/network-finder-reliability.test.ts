/**
 * REGRESSION (28 Oct, 18:35-19:35 IST): Network Finder stopped doing work. Every call either timed out at Vercel's
 * 60 s limit (rate-limited Sheets writes were retried with up to ~15 s of sleeping EACH, past the run's deadline) or
 * answered 409 "busy" (the killed run never released its lock, and the lock outlived the NEXT 5-minute call).
 * Also: a discovery source that ran past the deadline lost its paging cursor every call, so it re-read the same
 * pages forever. These tests reproduce each failure and prove the fix.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SheetsError } from "@/lib/google-sheets/errors";
import { setSheetsClientForTesting, setSheetsRetryDeadline, withRetry } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { RUN_BUDGET_MS, RUN_LOCK_TTL_MS } from "@/lib/network-finder/run";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { existingConnections, existingJobs } from "@/lib/network-finder/gateways";
import { discoverCompanies, type CompanyTask, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { createRemoteInTechSource } from "@/lib/network-finder/providers/public-sources";
import { InMemoryQueue, LEASE_MS } from "@/lib/network-finder/queue";
import { InMemoryCompanyRegistry } from "@/lib/network-finder/registry";
import { InMemoryBatchLedger } from "@/lib/network-finder/scheduler";
import { createSheetsStores } from "@/lib/network-finder/sheets-stores";
import { FakeSheets } from "../helpers/fake-sheets";
import { mockCompany, MockCompanySource, mockWeb, testFetcher } from "../helpers/network-finder-mocks";

let sheets: FakeSheets;
beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  setSheetsRetryDeadline(null);
});

const rateLimited = () => new SheetsError("rate_limited", "busy");

describe("rate-limited Sheets calls stop retrying at the run's deadline", () => {
  it("BEFORE the fix every call slept through all 5 attempts (~15 s each); with a deadline it fails at once", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    // No deadline (the web app, tests): all retries are used, as before.
    let attempts = 0;
    await expect(withRetry(async () => { attempts++; throw rateLimited(); }, sleep, { random: () => 0.5 })).rejects.toMatchObject({ code: "rate_limited" });
    expect(attempts).toBe(5);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThan(10_000);

    // A scheduled run's deadline: the first retry whose wait would pass it is not slept; the error surfaces immediately.
    sleeps.length = 0;
    attempts = 0;
    setSheetsRetryDeadline(Date.now() + 500);
    await expect(withRetry(async () => { attempts++; throw rateLimited(); }, sleep, { random: () => 0.5 })).rejects.toMatchObject({ code: "rate_limited" });
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("a retry that fits before the deadline still happens", async () => {
    setSheetsRetryDeadline(Date.now() + 60_000);
    let attempts = 0;
    const result = await withRetry(async () => { if (++attempts < 3) throw rateLimited(); return "ok"; }, async () => undefined, { random: () => 0.5 });
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });
});

describe("a killed run cannot block the next scheduled call", () => {
  it("the run lock expires before the next 5-minute call (it used to outlive it, so alternate calls were 409 busy)", async () => {
    expect(RUN_LOCK_TTL_MS).toBeGreaterThan(60_000); // longer than the function's 60 s limit
    expect(RUN_LOCK_TTL_MS).toBeLessThan(5 * 60_000 - 60_000); // gone well before the next call
    expect(RUN_BUDGET_MS).toBeLessThan(RUN_LOCK_TTL_MS);
    const t0 = Date.UTC(2026, 9, 28, 13, 0);
    const killed = createSheetsStores();
    expect(await killed.acquireRunLock(t0, RUN_LOCK_TTL_MS)).toBe(true); // ...and then Vercel kills the run: no release
    const next = createSheetsStores();
    expect(await next.acquireRunLock(t0 + 30_000, RUN_LOCK_TTL_MS)).toBe(false); // a genuinely concurrent call still gets "busy"
    expect(await next.acquireRunLock(t0 + 5 * 60_000, RUN_LOCK_TTL_MS)).toBe(true); // the next scheduled call runs
  });

  it("a company claimed by a killed run is offered again before the next call", async () => {
    expect(LEASE_MS).toBeLessThan(5 * 60_000);
    const q = new InMemoryQueue<number>();
    await q.enqueue("company:x", 1, 0);
    await q.claim(0);
    expect(await q.claim(60_000)).toBeNull();
    expect((await q.claim(5 * 60_000 - 1))?.id).toBe("company:x");
  });
});

describe("discovery never loses its place or overruns the run", () => {
  function remoteIntechWeb(n: number) {
    const routes: Record<string, string | { type: string; body: string }> = {
      "https://api.github.com/repos/remoteintech/remote-jobs/git/trees/main?recursive=1": { type: "application/json", body: JSON.stringify({ tree: Array.from({ length: n }, (_, i) => ({ path: `src/companies/co-${String(i).padStart(2, "0")}.md` })) }) },
    };
    for (let i = 0; i < n; i++) routes[`https://raw.githubusercontent.com/remoteintech/remote-jobs/main/src/companies/co-${String(i).padStart(2, "0")}.md`] = `---\ntitle: Co ${i}\nwebsite: https://co${i}.example.test\ncompany_size: small\nremote_policy: remote\n---\n## Company size\n12 people`;
    return mockWeb(routes);
  }

  it("a pass that runs out of time stops, and returns the cursor reached (it used to be killed and lose it)", async () => {
    const web = remoteIntechWeb(30);
    const source = createRemoteInTechSource(testFetcher(web.fetchFn));
    // With ample time: pages through as before.
    const roomy = await source.discover({ maxEmployees: 250, countries: ["US"], limit: 5, deadline: Date.now() + 120_000 });
    expect(roomy.companies).toHaveLength(5);
    expect(roomy.nextCursor).toBe("5");
    // Out of time: no profile is fetched, the position is kept.
    const before = web.requests.length;
    const late = await source.discover({ maxEmployees: 250, countries: ["US"], limit: 5, cursor: "5", deadline: Date.now() + 5_000 });
    expect(late.companies).toEqual([]);
    expect(late.nextCursor).toBe("5");
    expect(web.requests.length).toBe(before);
  });

  it("a source is not started with too little time left; the run reports it instead of being killed", async () => {
    const source = new MockCompanySource("yc", [mockCompany(1)]);
    const deps: PipelineDeps = {
      config: loadNetworkFinderConfig({ NETWORK_FINDER_ENABLED: "true", NETWORK_FINDER_CONNECTION_DISCOVERY: "true", APP_TIMEZONE: "Asia/Kolkata" } as unknown as NodeJS.ProcessEnv),
      sources: [source],
      jobSources: [],
      queue: new InMemoryQueue<CompanyTask>(),
      registry: new InMemoryCompanyRegistry(),
      ledger: new InMemoryBatchLedger(),
      connections: existingConnections,
      jobs: existingJobs,
      now: () => new Date(Date.UTC(2026, 9, 28, 13, 0)),
      runState: { deadline: Date.now() + 5_000 },
    };
    const result = await discoverCompanies(deps, 10);
    expect(source.calls).toHaveLength(0);
    expect(result.errors.join()).toMatch(/not enough time left/);
    deps.runState = { deadline: Date.now() + 45_000 };
    expect((await discoverCompanies(deps, 10)).enqueued).toHaveLength(1);
    expect(source.calls).toHaveLength(1);
  });
});
