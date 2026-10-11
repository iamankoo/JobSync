import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as cron } from "@/app/api/cron/retention/route";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { planRetention, retentionEnabled, runRetention } from "@/lib/google-sheets/retention-service";
import { getDueFollowUps } from "@/lib/google-sheets/follow-up-service";
import { listJobsForMember } from "@/lib/google-sheets/jobs-service";
import { listMyApplications } from "@/lib/google-sheets/applications-service";
import { getDashboardData } from "@/lib/google-sheets/insights-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { readActivity, readApplications } from "@/lib/google-sheets/repositories";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const NOW = new Date("2026-10-31T12:00:00.000Z");
const ENABLED = { RETENTION_CLEANUP_ENABLED: "true" } as unknown as NodeJS.ProcessEnv;
const daysBefore = (d: number, extraMs = 0) => new Date(NOW.getTime() - d * 86_400_000 - extraMs).toISOString();

/** Test-only fixture rows written straight into the (fake) sheet with chosen timestamps. */
function job(id: string, addedAt: string) {
  sheets.rows("Jobs").push([id, `Synthetic Co ${id}`, `Test Role ${id}`, "Internship", "", "", "", "Testville", `https://jobs.example.test/${id}`, "", "", "anni", addedAt]);
}
function application(id: string, who: string, appliedAt: string, answer = "") {
  sheets.rows("Applications").push([id, who, "Applied", appliedAt, "", "", appliedAt, answer, answer ? appliedAt : ""]);
}
function activity(n: number, who: string, action: string, jobId: string) {
  sheets.rows("Activity").push([`act_${n}`, who, "2026-10-01", action, jobId, "2026-10-01T10:00:00.000Z"]);
}

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => {
  setSheetsClientForTesting(null);
  vi.unstubAllEnvs();
});

describe("retention dry run (read-only)", () => {
  beforeEach(() => {
    job("old", daysBefore(45));
    job("edge", daysBefore(30)); // exactly 30 days: expired
    job("fresh", daysBefore(29, 23 * 3_600_000)); // 29 d 23 h: kept
    application("old", "anni", daysBefore(40));
    application("old", "lukky", daysBefore(40), "Shortlisted");
    application("edge", "rishii", daysBefore(30));
    application("fresh", "anni", daysBefore(2));
  });

  it("lists exactly the expired jobs with their ages and the application rows that would go with them", async () => {
    const plan = await planRetention(NOW);
    expect(plan).toMatchObject({ retentionDays: 30, totalJobs: 3, applicationRowsToDelete: 3, unreadableJobRows: 0 });
    expect(plan.expiredJobs.map((j) => [j.jobId, j.ageDays, j.applicationRows])).toEqual([["old", 45, 2], ["edge", 30, 1]]);
  });

  it("never writes: only reads reach the spreadsheet", async () => {
    await planRetention(NOW);
    expect(sheets.calls.every((c) => c.op === "get")).toBe(true);
    expect(sheets.dataRows("Jobs")).toHaveLength(3);
    expect(sheets.dataRows("Applications")).toHaveLength(4);
  });

  it("an empty database yields an empty plan", async () => {
    sheets = new FakeSheets().seedMembers();
    setSheetsClientForTesting(sheets);
    expect(await planRetention(NOW)).toMatchObject({ totalJobs: 0, expiredJobs: [], applicationRowsToDelete: 0 });
  });

  it("job rows with invalid or missing timestamps are reported as unreadable and never planned for deletion", async () => {
    sheets.rows("Jobs").push(["bad1", "C", "R", "Internship", "", "", "", "L", "https://jobs.example.test/b1", "", "", "anni", "last year"]);
    sheets.rows("Jobs").push(["bad2", "C", "R", "Internship", "", "", "", "L", "https://jobs.example.test/b2", "", "", "anni", ""]);
    const plan = await planRetention(NOW);
    expect(plan.unreadableJobRows).toBe(2);
    expect(plan.expiredJobs.map((j) => j.jobId)).toEqual(["old", "edge"]);
  });
});

describe("retention cleanup", () => {
  beforeEach(() => {
    job("old", daysBefore(45));
    job("edge", daysBefore(30));
    job("fresh", daysBefore(5));
    application("old", "anni", daysBefore(40));
    application("old", "lukky", daysBefore(40), "Offer");
    application("edge", "rishii", daysBefore(30));
    application("fresh", "anni", daysBefore(2));
    application("fresh", "lukky", daysBefore(1));
    activity(1, "anni", "job_added", "old");
    activity(2, "anni", "job_applied", "fresh");
  });

  it("is DISABLED unless explicitly enabled, and deletes nothing when disabled", async () => {
    expect(retentionEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(retentionEnabled({ RETENTION_CLEANUP_ENABLED: "yes" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(retentionEnabled(ENABLED)).toBe(true);
    await expect(runRetention(NOW, { env: {} as NodeJS.ProcessEnv })).rejects.toMatchObject({ code: "retention_disabled" });
    expect(sheets.dataRows("Jobs")).toHaveLength(3);
    expect(sheets.calls.filter((c) => c.op !== "get")).toHaveLength(0);
  });

  it("deletes expired jobs together with ALL their application rows, leaving no orphans and keeping everything else", async () => {
    const result = await runRetention(NOW, { env: ENABLED });
    expect(result).toMatchObject({ executed: true, deletedJobs: 2, deletedApplicationRows: 3 });
    expect(sheets.dataRows("Jobs").map((r) => r[0])).toEqual(["fresh"]);
    expect(sheets.dataRows("Applications").map((r) => [r[0], r[1]])).toEqual([["fresh", "anni"], ["fresh", "lukky"]]);
    // no application or follow-up record references a deleted job
    const jobIds = new Set(sheets.dataRows("Jobs").map((r) => r[0]));
    expect((await readApplications()).items.every((a) => jobIds.has(a.jobId))).toBe(true);
  });

  it("clears deleted jobs' references from Activity but keeps the history rows", async () => {
    await runRetention(NOW, { env: ENABLED });
    const items = (await readActivity()).items;
    expect(items).toHaveLength(2);
    expect(items.find((a) => a.activityId === "act_1")?.jobId).toBeUndefined();
    expect(items.find((a) => a.activityId === "act_2")?.jobId).toBe("fresh");
  });

  it("is idempotent: a second run has nothing to do", async () => {
    await runRetention(NOW, { env: ENABLED });
    expect(await runRetention(NOW, { env: ENABLED })).toMatchObject({ deletedJobs: 0, deletedApplicationRows: 0 });
    expect(sheets.dataRows("Jobs")).toHaveLength(1);
  });

  it("refuses runs that would delete suspiciously many jobs (clock or data problems)", async () => {
    const snapshot = JSON.stringify([sheets.rows("Jobs"), sheets.rows("Applications")]);
    await expect(runRetention(NOW, { env: ENABLED, maxJobs: 1 })).rejects.toMatchObject({ code: "retention_limit" });
    expect(JSON.stringify([sheets.rows("Jobs"), sheets.rows("Applications")])).toBe(snapshot);
  });

  it("never touches jobs with invalid timestamps, nor jobs added in the future", async () => {
    sheets.rows("Jobs").push(["bad", "C", "R", "Internship", "", "", "", "L", "https://jobs.example.test/bad", "", "", "anni", "not a date"]);
    job("future", new Date(NOW.getTime() + 86_400_000).toISOString());
    application("bad", "anni", daysBefore(100)); // an application pointing at the unreadable job
    await runRetention(NOW, { env: ENABLED });
    const ids = sheets.dataRows("Jobs").map((r) => r[0]);
    expect(ids).toContain("bad");
    expect(ids).toContain("future");
    expect(ids).toContain("fresh");
    expect(sheets.dataRows("Applications").some((r) => r[0] === "bad")).toBe(true);
  });

  it("an interrupted run finishes on the next run (applications go first, so no orphans can appear)", async () => {
    const original = sheets.deleteRows.bind(sheets);
    sheets.deleteRows = async (tab, rows) => {
      if (tab === "Jobs") throw googleError(500); // jobs deletion fails after applications were removed
      return original(tab, rows);
    };
    await expect(runRetention(NOW, { env: ENABLED })).rejects.toBeDefined();
    expect(sheets.dataRows("Applications").map((r) => r[0])).toEqual(["fresh", "fresh"]); // already gone for expired jobs
    expect(sheets.dataRows("Jobs")).toHaveLength(3); // jobs still there
    sheets.deleteRows = original;
    expect(await runRetention(NOW, { env: ENABLED })).toMatchObject({ deletedJobs: 2, deletedApplicationRows: 0 });
    expect(sheets.dataRows("Jobs").map((r) => r[0])).toEqual(["fresh"]);
  });
});

describe("retention and follow-ups work together", () => {
  it("follow-ups never extend a job's life: an expired job is not asked about even before cleanup runs", async () => {
    job("old", daysBefore(45));
    application("old", "anni", daysBefore(35)); // applied 35 days ago: long past 168 h
    expect((await getDueFollowUps("anni", NOW)).due).toEqual([]);
    // and cleanup then removes the application together with the job, so no follow-up record is orphaned
    await runRetention(NOW, { env: ENABLED });
    expect(sheets.dataRows("Applications")).toHaveLength(0);
  });

  it("a job inside its 30 days is still asked; once expired it is neither asked nor shown as an application", async () => {
    job("j", daysBefore(20));
    application("j", "anni", daysBefore(10));
    expect((await getDueFollowUps("anni", NOW)).due).toHaveLength(1);
    const later = new Date(NOW.getTime() + 11 * 86_400_000); // job now 31 days old
    expect((await getDueFollowUps("anni", later)).due).toEqual([]);
  });

  it("after cleanup every page shows only live data", async () => {
    job("old", daysBefore(45));
    job("fresh", daysBefore(3));
    application("old", "anni", daysBefore(40));
    application("fresh", "anni", daysBefore(2));
    await runRetention(NOW, { env: ENABLED });
    expect((await listJobsForMember("anni")).jobs.map((j) => j.jobId)).toEqual(["fresh"]);
    expect((await listMyApplications("anni")).rows.map((r) => r.job.jobId)).toEqual(["fresh"]);
    const d = await getDashboardData("anni", NOW);
    expect([d.totalJobs, d.myApplied]).toEqual([1, 1]);
  });
});

describe("GET /api/cron/retention", () => {
  const req = (auth?: string) => new Request("http://localhost/api/cron/retention", { headers: auth ? { authorization: auth } : {} });
  // the endpoint evaluates against the REAL clock, so these fixtures are relative to it
  const realAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  beforeEach(() => {
    job("old", realAgo(45));
    application("old", "anni", realAgo(40));
  });

  it("is off without CRON_SECRET", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await cron(req("Bearer anything"))).status).toBe(503);
  });

  it("rejects missing or wrong credentials without touching data", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-value-for-tests");
    expect((await cron(req())).status).toBe(401);
    expect((await cron(req("Bearer nope"))).status).toBe(401);
    expect((await cron(req("s3cret-value-for-tests"))).status).toBe(401);
    expect(sheets.calls).toHaveLength(0);
  });

  it("defaults to a dry run: reports what would be deleted and deletes nothing", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-value-for-tests");
    vi.stubEnv("RETENTION_CLEANUP_ENABLED", "");
    const res = await cron(req("Bearer s3cret-value-for-tests"));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.dryRun).toBe(true);
    expect(data.expiredJobs).toHaveLength(1);
    expect(sheets.dataRows("Jobs")).toHaveLength(1);
    expect(sheets.calls.every((c) => c.op === "get")).toBe(true);
  });

  it("deletes only when RETENTION_CLEANUP_ENABLED=true", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-value-for-tests");
    vi.stubEnv("RETENTION_CLEANUP_ENABLED", "true");
    const res = await cron(req("Bearer s3cret-value-for-tests"));
    expect((await res.json()).data).toMatchObject({ dryRun: false, executed: true, deletedJobs: 1 });
    expect(sheets.dataRows("Jobs")).toHaveLength(0);
  });

  it("never echoes the secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-value-for-tests");
    const text = await (await cron(req("Bearer wrong"))).text();
    expect(text).not.toContain("s3cret-value-for-tests");
  });
});
