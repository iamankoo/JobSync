import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLiveEnv } from "../helpers/live-env";
import { snapshotProduction } from "../helpers/live-sheets";

/**
 * STRICTLY READ-ONLY look at the PRODUCTION spreadsheet (`npm run test:prod-readonly`).
 *
 * Every Sheets call goes through a guard that THROWS on append / update / delete, so even a bug in
 * this file or in the services it calls cannot write. A before/after snapshot proves it, too.
 * It reports counts, IDs and titles only: no notes, no private text.
 */
const env = loadLiveEnv();
const log = (label: string, value: unknown) => console.log(`PROD ${label}: ${JSON.stringify(value)}`);
let before: Awaited<ReturnType<typeof snapshotProduction>>;
let writesAttempted = 0;

beforeAll(async () => {
  if (!env.email || !env.privateKey || !env.prodId) throw new Error("Production credentials/ID are not in .env.local");
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID = env.prodId;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = env.email;
  process.env.GOOGLE_PRIVATE_KEY = env.privateKey;
  process.env.SHEETS_CACHE_TTL_MS = "0";
  delete process.env.SHEETS_TEST_BACKEND;
  delete process.env.RETENTION_CLEANUP_ENABLED; // destructive cleanup stays disabled
  before = await snapshotProduction();

  const { getSheetsClient, setSheetsClientForTesting } = await import("@/lib/google-sheets/client");
  const real = getSheetsClient();
  const refuse = (op: string) => async () => {
    writesAttempted += 1;
    throw new Error(`READ-ONLY GUARD: ${op} is not allowed against production`);
  };
  setSheetsClientForTesting({
    getValues: (range) => real.getValues(range),
    appendValues: refuse("append"),
    updateValues: refuse("update"),
    deleteRows: refuse("delete"),
  });
});

afterAll(async () => {
  const after = await snapshotProduction();
  log("snapshot before", before);
  log("snapshot after", after);
  log("write attempts blocked by the guard", writesAttempted);
  expect(writesAttempted).toBe(0);
  expect(after).toEqual(before);
});

describe("production (read-only)", () => {
  it("all four tabs read cleanly, including the follow-up headers Applications!H1:I1", async () => {
    const { checkSheetsStatus } = await import("@/lib/google-sheets/status-service");
    const res = await checkSheetsStatus();
    log("status", res);
    expect(res.ok).toBe(true);
    const { getDueFollowUps } = await import("@/lib/google-sheets/follow-up-service");
    const overview = await getDueFollowUps("anni", new Date());
    log("follow-ups enabled (headers H1:I1 recognised)", overview.enabled);
    expect(overview.enabled).toBe(true);
  });

  it("follow-up status for each member (read-only): nobody is prompted early", async () => {
    const { getDueFollowUps } = await import("@/lib/google-sheets/follow-up-service");
    for (const who of ["anni", "lukky", "rishii"] as const) {
      const o = await getDueFollowUps(who, new Date());
      log(`due follow-ups ${who}`, { enabled: o.enabled, due: o.due.map((d) => [d.jobId, d.appliedAt, d.dueAt]), invalid: o.invalid });
      expect(o.due).toEqual([]); // every production application is far younger than 168 h today
    }
  });

  it("retention DRY RUN: every proposed deletion is listed; nothing is deleted", async () => {
    const { planRetention, retentionEnabled } = await import("@/lib/google-sheets/retention-service");
    expect(retentionEnabled()).toBe(false);
    const plan = await planRetention(new Date());
    log("retention dry run", {
      evaluatedAt: plan.evaluatedAt, retentionDays: plan.retentionDays, totalJobs: plan.totalJobs,
      proposedJobDeletions: plan.expiredJobs.map((j) => ({ jobId: j.jobId, company: j.company, role: j.jobRole, addedAt: j.addedAt, ageDays: j.ageDays, applicationRows: j.applicationRows })),
      applicationRowsToDelete: plan.applicationRowsToDelete, unreadableJobRows: plan.unreadableJobRows,
    });
    expect(plan.retentionDays).toBe(30);
  });
});
