import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadLiveEnv, requireSafeTestEnv } from "../helpers/live-env";
import { openTestSheet, snapshotProduction } from "../helpers/live-sheets";

/**
 * LIVE integration tests: the real application services talking to the REAL Google Sheets API,
 * pointed at the DISPOSABLE test spreadsheet only.
 *
 * Safety:
 *  - The spreadsheet ID comes only from GOOGLE_TEST_SPREADSHEET_ID in .env.test.local. There is no
 *    fallback to the production ID; the run fails if it is missing or equal to the production ID.
 *  - A read-only snapshot of the production spreadsheet is taken before and after; the run fails if
 *    it changed.
 *  - Everything the tests create is clearly marked "[LIVE TEST]" and the test sheet is cleared at the
 *    end (it is disposable).
 */
const env = loadLiveEnv();
const MARK = "[LIVE TEST]";
const T0 = new Date();

let sheet: ReturnType<typeof openTestSheet>;
let before: Awaited<ReturnType<typeof snapshotProduction>>;
const log = (label: string, value: unknown) => console.log(`LIVE ${label}: ${JSON.stringify(value)}`);

// the service layer reads its config from process.env at call time, so point it at the TEST sheet
type Services = {
  jobs: typeof import("@/lib/google-sheets/jobs-service");
  apps: typeof import("@/lib/google-sheets/applications-service");
  follow: typeof import("@/lib/google-sheets/follow-up-service");
  status: typeof import("@/lib/google-sheets/status-service");
  members: typeof import("@/lib/google-sheets/members-service");
  insights: typeof import("@/lib/google-sheets/insights-service");
  client: typeof import("@/lib/google-sheets/client");
};
let s: Services;

beforeAll(async () => {
  const safe = requireSafeTestEnv(); // throws (fails the suite) when unset, or equal to production
  expect(safe.testId).not.toBe(safe.prodId);
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID = safe.testId;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = safe.email;
  process.env.GOOGLE_PRIVATE_KEY = safe.privateKey;
  process.env.SHEETS_CACHE_TTL_MS = "0";
  delete process.env.SHEETS_TEST_BACKEND; // the real Google client, never the in-memory one

  sheet = openTestSheet();
  expect(await sheet.title()).toMatch(/^JobSync TEST/); // refuse anything not titled as a test sheet
  before = await snapshotProduction();
  await sheet.reset();

  s = {
    jobs: await import("@/lib/google-sheets/jobs-service"),
    apps: await import("@/lib/google-sheets/applications-service"),
    follow: await import("@/lib/google-sheets/follow-up-service"),
    status: await import("@/lib/google-sheets/status-service"),
    members: await import("@/lib/google-sheets/members-service"),
    insights: await import("@/lib/google-sheets/insights-service"),
    client: await import("@/lib/google-sheets/client"),
  };
  s.members.resetMembersCache();
});

// Google allows ~60 read requests per minute per user; pace the tests so the suite stays under it
// (the app already retries with backoff, this just avoids relying on that).
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 6_000));
});

afterAll(async () => {
  if (!sheet) return;
  await sheet.reset(); // clean up everything the tests created (disposable sheet)
  const leftover = (await sheet.dataRows("Jobs")).length + (await sheet.dataRows("Applications")).length + (await sheet.dataRows("Activity")).length;
  log("cleanup leftover rows (Jobs+Applications+Activity)", leftover);
  expect(leftover).toBe(0);
  // production must be byte-for-byte what it was (read-only comparison)
  const after = await snapshotProduction();
  log("production snapshot before", before);
  log("production snapshot after", after);
  expect(after).toEqual(before);
});

describe("safe configuration", () => {
  it("uses a distinct, configured test spreadsheet", () => {
    expect(env.unavailable).toBeUndefined();
    expect(env.testId).toBeTruthy();
    expect(env.testId).not.toBe(env.prodId);
  });
  it("the real client is in use (not the in-memory backend)", () => {
    expect(s.client.isMemoryBackend()).toBe(false);
  });
});

describe("real Google Sheets API", () => {
  let jobAnni = "";
  let jobLukky = "";

  it("status check: all tabs readable with the expected headers (including the follow-up columns)", async () => {
    const res = await s.status.checkSheetsStatus();
    log("status", res);
    expect(res.ok).toBe(true);
    expect(res.tabs.map((t) => t.tab.toLowerCase()).sort()).toEqual(["activity", "applications", "callsignals", "chatfiles", "chatmessages", "chatreads", "connections", "jobs", "members", "notificationlog", "pushsubscriptions"]);
    expect(res.tabs.every((t) => t.ok)).toBe(true);
    const header = (await sheet.readTab("Applications"))[0];
    expect(header.slice(7, 9)).toEqual(["FollowUpAnswer", "FollowUpAnsweredAt"]);
  });

  it("reads an empty Jobs tab", async () => {
    const { jobs, skippedRows } = await s.jobs.listJobsForMember("anni");
    log("empty list", { jobs: jobs.length, skippedRows });
    expect(jobs).toEqual([]);
    expect(skippedRows).toBe(0);
  });

  it("adds a job, then reads it back from the sheet and through the service", async () => {
    const job = await s.jobs.createJob("anni", {
      company: `${MARK} Co`, jobRole: `${MARK} Role`, jobType: "Full-time", experience: "Fresher", location: "Hybrid",
      jobUrl: "https://example.test/live-1", description: "Created by the live integration test",
    });
    jobAnni = job.jobId;
    log("created job", { jobId: job.jobId, addedBy: job.addedBy, addedAt: job.addedAt });
    expect(job.jobId).toMatch(/^job_[0-9a-f-]{36}$/);
    expect(job.addedBy).toBe("anni");
    expect(Math.abs(Date.parse(job.addedAt) - Date.now())).toBeLessThan(120_000); // server clock

    // read it back DIRECTLY from the spreadsheet (independent of the app code)
    const raw = (await sheet.dataRows("Jobs")).find((r) => r[0] === jobAnni)!;
    log("raw Jobs row", raw);
    expect(raw).toBeTruthy();
    expect(raw).toContain(`${MARK} Role`);
    expect(raw).toContain("anni");
    expect(raw).toContain("https://example.test/live-1");

    const { jobs } = await s.jobs.listJobsForMember("anni");
    expect(jobs.map((j) => j.jobId)).toEqual([jobAnni]);
    expect(jobs[0].myStatus).toBe("Not Applied");
  });

  it("refuses a duplicate link and writes nothing", async () => {
    await expect(
      s.jobs.createJob("lukky", { company: "Dup", jobRole: "Dup", jobType: "Full-time", experience: "Fresher", location: "Hybrid", jobUrl: "https://example.test/live-1" }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/duplicate/) });
    expect((await sheet.dataRows("Jobs")).length).toBe(1);
  });

  it("another member adds a second job; both are shared with everyone", async () => {
    const job = await s.jobs.createJob("lukky", {
      company: `${MARK} Co 2`, jobRole: `${MARK} Role 2`, jobType: "Internship", experience: "Fresher", location: "Hybrid", jobUrl: "https://example.test/live-2",
    });
    jobLukky = job.jobId;
    expect(job.addedBy).toBe("lukky");
    for (const who of ["anni", "lukky", "rishii"] as const) {
      const { jobs } = await s.jobs.listJobsForMember(who);
      expect(jobs.map((j) => j.jobId).sort()).toEqual([jobAnni, jobLukky].sort());
    }
  });

  it("creates and updates an application; it is persisted and the member's own", async () => {
    const created = await s.apps.setApplicationStatus("anni", jobAnni, { status: "Applied" });
    log("application created", created);
    let raw = (await sheet.dataRows("Applications")).find((r) => r[0] === jobAnni && r[1] === "anni")!;
    log("raw Applications row", raw);
    expect(raw[2]).toBe("Applied");
    expect(Date.parse(raw[3])).not.toBeNaN(); // AppliedAt set by the server

    await s.apps.setApplicationStatus("anni", jobAnni, { status: "In Progress", applicationStage: "Screening", notes: "live note" });
    raw = (await sheet.dataRows("Applications")).find((r) => r[0] === jobAnni && r[1] === "anni")!;
    expect(raw.slice(2, 6)).toEqual(["In Progress", raw[3], "Screening", "live note"]);
    expect((await sheet.dataRows("Applications")).filter((r) => r[0] === jobAnni).length).toBe(1); // updated in place
  });

  it("member isolation: other members see the job but not Anni's status, notes or application", async () => {
    const lukkyView = (await s.jobs.listJobsForMember("lukky")).jobs.find((j) => j.jobId === jobAnni)!;
    const rishiiView = (await s.jobs.listJobsForMember("rishii")).jobs.find((j) => j.jobId === jobAnni)!;
    expect(lukkyView.myStatus).toBe("Not Applied");
    expect(rishiiView.myStatus).toBe("Not Applied");
    expect((await s.apps.listMyApplications("lukky")).rows).toEqual([]);
    expect((await s.apps.listMyApplications("anni")).rows.map((r) => r.job.jobId)).toEqual([jobAnni]);

    // Lukky's own application is independent and does not change Anni's
    await s.apps.setApplicationStatus("lukky", jobAnni, { status: "Applied" });
    await s.apps.setApplicationStatus("lukky", jobAnni, { status: "Rejected" });
    const anni = (await s.jobs.listJobsForMember("anni")).jobs.find((j) => j.jobId === jobAnni)!;
    expect(anni.myStatus).toBe("In Progress");
    const rows = (await sheet.dataRows("Applications")).filter((r) => r[0] === jobAnni);
    expect(rows.map((r) => `${r[1]}:${r[2]}`).sort()).toEqual(["anni:In Progress", "lukky:Rejected"]);
  });

  it("invalid transitions are refused and change nothing", async () => {
    const before = await sheet.dataRows("Applications");
    await expect(s.apps.setApplicationStatus("rishii", jobAnni, { status: "Offer" })).rejects.toMatchObject({ code: expect.stringMatching(/transition/) });
    expect(await sheet.dataRows("Applications")).toEqual(before);
  });

  it("7-day follow-up: due after 168 h, answer persisted in the optional columns, never asked again", async () => {
    const later = new Date(Date.now() + 169 * 3_600_000);
    const due = await s.follow.getDueFollowUps("anni", later);
    log("due follow-ups", due);
    expect(due.enabled).toBe(true);
    expect(due.due.map((d) => d.jobId)).toEqual([jobAnni]);
    await s.follow.answerFollowUp("anni", jobAnni, "Shortlisted", later);
    const raw = (await sheet.dataRows("Applications")).find((r) => r[0] === jobAnni && r[1] === "anni")!;
    log("raw row after follow-up", raw);
    expect(raw[7]).toBe("Shortlisted");
    expect(Date.parse(raw[8])).not.toBeNaN();
    expect((await s.follow.getDueFollowUps("anni", later)).due).toEqual([]);
  });

  it("answering a follow-up on a legacy 7-column row changes only that row; neighbours stay byte-identical", async () => {
    const old = new Date(Date.now() - 200 * 3_600_000).toISOString();
    await sheet.appendRaw("Applications", [jobLukky, "rishii", "Applied", old, "", "", old]); // legacy row: no follow-up cells
    const others = (await sheet.dataRows("Applications")).filter((r) => r[1] !== "rishii");
    const answered = await s.follow.answerFollowUp("rishii", jobLukky, "Interview", new Date());
    log("legacy row answered", answered);
    const rows = await sheet.dataRows("Applications");
    expect(rows.filter((r) => r[1] !== "rishii")).toEqual(others); // everyone else's rows unchanged
    const mine = rows.find((r) => r[1] === "rishii")!;
    log("legacy row after answer", mine);
    expect(mine.slice(0, 4)).toEqual([jobLukky, "rishii", "Interview", old]); // AppliedAt preserved, status advanced
    expect(mine[7]).toBe("Interview");
  });

  it("activity events were recorded for the real actions", async () => {
    const acts = await sheet.dataRows("Activity");
    log("activity actions", acts.map((r) => `${r[1]}:${r[3]}`));
    const has = (member: string, action: string) => acts.some((r) => r[1] === member && r[3] === action);
    expect(has("anni", "job_added")).toBe(true);
    expect(has("lukky", "job_added")).toBe(true);
    expect(has("anni", "job_applied")).toBe(true);
    expect(has("anni", "follow_up_answered")).toBe(true);
  });

  it("dashboard and analytics read the real persisted data with exact numbers", async () => {
    const dash = await s.insights.getDashboardData("anni", new Date(Date.now() + 169 * 3_600_000));
    log("dashboard", { totalJobs: dash.totalJobs, myApplied: dash.myApplied, myPending: dash.myPending });
    expect(dash.totalJobs).toBe(2);
    expect(dash.myApplied).toBe(1);
  });

  it("owner-only delete: a non-owner is refused; the owner deletes the job and its application rows", async () => {
    await expect(s.jobs.deleteJob("lukky", jobAnni)).rejects.toMatchObject({ code: "not_job_owner" });
    expect((await sheet.dataRows("Jobs")).some((r) => r[0] === jobAnni)).toBe(true);
    await s.jobs.deleteJob("anni", jobAnni);
    expect((await sheet.dataRows("Jobs")).some((r) => r[0] === jobAnni)).toBe(false);
    log("jobs left after delete", (await sheet.dataRows("Jobs")).map((r) => r[0]));
  });

  it("an inactive member is refused (Members tab is honoured)", async () => {
    await sheet.setMemberActive("rishii", false);
    s.members.resetMembersCache();
    expect(await s.members.isMemberActive("rishii", Date.now() + 120_000)).toBe(false);
    await sheet.setMemberActive("rishii", true);
    s.members.resetMembersCache();
    expect(await s.members.isMemberActive("rishii", Date.now() + 240_000)).toBe(true);
  });
});

void T0;
