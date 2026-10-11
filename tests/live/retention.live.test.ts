import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { requireSafeTestEnv } from "../helpers/live-env";
import { openTestSheet, snapshotProduction } from "../helpers/live-sheets";

/**
 * LIVE retention test: the real cleanup code deleting real rows through the real Google API, on the
 * DISPOSABLE test spreadsheet only (same safety rules as sheets.live.test.ts).
 */
const DAY = 86_400_000;
const NOW = new Date();
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs).toISOString();

let sheet: ReturnType<typeof openTestSheet>;
let before: Awaited<ReturnType<typeof snapshotProduction>>;
type Retention = typeof import("@/lib/google-sheets/retention-service");
let retention: Retention;
const log = (label: string, value: unknown) => console.log(`LIVE ${label}: ${JSON.stringify(value)}`);

const jobRow = (id: string, addedAt: string, by = "anni") =>
  [id, `[LIVE TEST] ${id}`, "Role", "Full-time", "", "Fresher", "", "Hybrid", `https://example.test/${id}`, "", "", by, addedAt];
const appRow = (id: string, member: string) => [id, member, "Applied", ago(2), "", "", ago(2), "Shortlisted", ago(1)];
const actRow = (n: number, member: string, jobId: string) => [`act_live_${n}`, member, "2026-10-01", "job_applied", jobId, ago(2)];

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 6_000)); // stay under Google's read quota
});

beforeAll(async () => {
  const safe = requireSafeTestEnv();
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID = safe.testId;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = safe.email;
  process.env.GOOGLE_PRIVATE_KEY = safe.privateKey;
  process.env.SHEETS_CACHE_TTL_MS = "0";
  delete process.env.SHEETS_TEST_BACKEND;
  delete process.env.RETENTION_CLEANUP_ENABLED;
  sheet = openTestSheet();
  expect(await sheet.title()).toMatch(/^JobSync TEST/);
  before = await snapshotProduction();
  await sheet.reset();
  retention = await import("@/lib/google-sheets/retention-service");

  // jobs: 31 d old (expired), 45 d old (expired), 29 d old (kept), brand new (kept), unreadable AddedAt (never deleted)
  await sheet.appendRaw("Jobs", jobRow("job_old31", ago(31)));
  await sheet.appendRaw("Jobs", jobRow("job_old45", ago(45), "lukky"));
  await sheet.appendRaw("Jobs", jobRow("job_keep29", ago(29)));
  await sheet.appendRaw("Jobs", jobRow("job_new", ago(0)));
  await sheet.appendRaw("Jobs", jobRow("job_badts", "not-a-timestamp"));
  // applications: two members on an expired job, one on a kept job, one on the unreadable job
  await sheet.appendRaw("Applications", appRow("job_old31", "anni"));
  await sheet.appendRaw("Applications", appRow("job_old31", "lukky"));
  await sheet.appendRaw("Applications", appRow("job_keep29", "anni"));
  await sheet.appendRaw("Applications", appRow("job_badts", "rishii"));
  await sheet.appendRaw("Activity", actRow(1, "anni", "job_old31"));
  await sheet.appendRaw("Activity", actRow(2, "anni", "job_keep29"));
});

afterAll(async () => {
  if (!sheet) return;
  await sheet.reset();
  expect((await sheet.dataRows("Jobs")).length + (await sheet.dataRows("Applications")).length + (await sheet.dataRows("Activity")).length).toBe(0);
  const after = await snapshotProduction();
  log("production snapshot before", before);
  log("production snapshot after", after);
  expect(after).toEqual(before);
});

describe("30-day retention on the disposable spreadsheet (real API)", () => {
  it("dry run lists exactly the expired jobs and deletes nothing", async () => {
    const plan = await retention.planRetention(NOW);
    log("dry run", { expired: plan.expiredJobs.map((j) => [j.jobId, j.ageDays, j.applicationRows]), applicationRowsToDelete: plan.applicationRowsToDelete, unreadable: plan.unreadableJobRows });
    expect(plan.expiredJobs.map((j) => j.jobId).sort()).toEqual(["job_old31", "job_old45"]);
    expect(plan.applicationRowsToDelete).toBe(2);
    expect(plan.unreadableJobRows).toBe(1);
    expect((await sheet.dataRows("Jobs")).length).toBe(5); // nothing deleted
    expect((await sheet.dataRows("Applications")).length).toBe(4);
  });

  it("refuses to delete while RETENTION_CLEANUP_ENABLED is not true", async () => {
    await expect(retention.runRetention(NOW)).rejects.toMatchObject({ code: "retention_disabled" });
    expect((await sheet.dataRows("Jobs")).length).toBe(5);
  });

  it("when enabled: deletes expired jobs and their application rows, scrubs Activity refs, keeps everything else", async () => {
    const res = await retention.runRetention(NOW, { env: { RETENTION_CLEANUP_ENABLED: "true" } as unknown as NodeJS.ProcessEnv });
    log("cleanup result", { executed: res.executed, deletedJobs: res.deletedJobs, deletedApplicationRows: res.deletedApplicationRows });
    expect(res).toMatchObject({ executed: true, deletedJobs: 2, deletedApplicationRows: 2 });

    const jobs = (await sheet.dataRows("Jobs")).map((r) => r[0]).sort();
    log("jobs left", jobs);
    expect(jobs).toEqual(["job_badts", "job_keep29", "job_new"]); // unreadable timestamp is never deleted
    const apps = (await sheet.dataRows("Applications")).map((r) => `${r[0]}:${r[1]}`).sort();
    log("applications left", apps);
    expect(apps).toEqual(["job_badts:rishii", "job_keep29:anni"]); // no orphans, kept jobs' applications untouched
    const acts = await sheet.dataRows("Activity");
    log("activity job refs", acts.map((r) => [r[0], r[4]]));
    expect(acts.find((r) => r[0] === "act_live_1")![4]).toBe(""); // reference to the deleted job cleared, history kept
    expect(acts.find((r) => r[0] === "act_live_2")![4]).toBe("job_keep29");
  });

  it("running it again changes nothing", async () => {
    const res = await retention.runRetention(NOW, { env: { RETENTION_CLEANUP_ENABLED: "true" } as unknown as NodeJS.ProcessEnv });
    expect(res).toMatchObject({ deletedJobs: 0, deletedApplicationRows: 0 });
    expect((await sheet.dataRows("Jobs")).length).toBe(3);
  });
});
