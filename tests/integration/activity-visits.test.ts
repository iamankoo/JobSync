import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { recordActivity, recordVisit, scrubDeletedJobReferences, VISIT_WINDOW_MS } from "@/lib/google-sheets/activity-service";
import { createJob, deleteJob } from "@/lib/google-sheets/jobs-service";
import { setApplicationStatus } from "@/lib/google-sheets/applications-service";
import { getAnalyticsSource, getDashboardData } from "@/lib/google-sheets/insights-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { readActivity } from "@/lib/google-sheets/repositories";
import { resetAllRateLimits } from "@/lib/auth/rate-limit";
import { buildActivityTimeline } from "@/lib/analytics/activity";
import { FakeSheets, googleError } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const T0 = new Date("2026-10-09T10:00:00.000Z");
const ms = (n: number, from: Date = T0) => new Date(from.getTime() + n);
const actions = async (who?: string) => (await readActivity()).items.filter((a) => !who || a.memberId === who).map((a) => a.action);

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
  resetAllRateLimits();
});
afterEach(() => setSheetsClientForTesting(null));

describe("visit tracking (presence, not work)", () => {
  it("records a visit and then at most one per member per 30 minutes", async () => {
    expect(await recordVisit("anni", T0)).toBe(true);
    for (const delta of [0, 1_000, 60_000, VISIT_WINDOW_MS - 1]) expect(await recordVisit("anni", ms(delta)), `+${delta}ms`).toBe(false);
    expect(await actions("anni")).toEqual(["visit"]);
    expect(await recordVisit("anni", ms(VISIT_WINDOW_MS))).toBe(true); // exactly 30 minutes later
    expect(await actions("anni")).toEqual(["visit", "visit"]);
  });

  it("each member has their own window", async () => {
    expect(await recordVisit("anni", T0)).toBe(true);
    expect(await recordVisit("lukky", ms(5_000))).toBe(true);
    expect(await recordVisit("anni", ms(10_000))).toBe(false);
    expect(await actions("lukky")).toEqual(["visit"]);
    expect(await actions("rishii")).toEqual([]);
  });

  it("simultaneous page loads or tabs write one row", async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => recordVisit("anni", T0)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await actions("anni")).toEqual(["visit"]);
  });

  it("a sign-in counts as presence too, so a visit right after login is not recorded again", async () => {
    await recordActivity("anni", "login", undefined, T0);
    expect(await recordVisit("anni", ms(60_000))).toBe(false);
    expect(await actions("anni")).toEqual(["login"]);
  });

  it("does not report a visit as recorded when the write fails, and does not throw", async () => {
    sheets.failNext = { op: "append", error: googleError(500) };
    expect(await recordVisit("anni", T0)).toBe(false);
    expect(await actions("anni")).toEqual([]);
    expect(await recordVisit("anni", ms(1000))).toBe(true); // the next attempt works
  });

  it("stores the calendar date in the configured application timezone (IST by default)", async () => {
    await recordVisit("anni", new Date("2026-10-08T20:00:00.000Z")); // 01:30 IST on the 9th
    const [row] = (await readActivity()).items;
    expect(row).toMatchObject({ date: "2026-10-09", timestamp: "2026-10-08T20:00:00.000Z" });
  });

  it("a visit alone is not a job, an application or an action in any summary", async () => {
    await recordVisit("anni", T0);
    const source = await getAnalyticsSource("anni", ms(60_000));
    const s = buildActivityTimeline(source.activity, "2026-10-09").summary;
    expect(s).toMatchObject({ visits: 1, totalActions: 0, jobsAdded: 0, applied: 0, activeDays: 0, daysVisited: 1 });
    const dash = await getDashboardData("anni", ms(60_000));
    expect(dash.totalJobs).toBe(0);
    expect(dash.daily.addedToday).toBe(0);
    expect(dash.contribution.all.every((r) => r.actions === 0 && r.count === 0)).toBe(true);
  });
});

describe("sign-in activity", () => {
  const req = (body: unknown) =>
    new Request("http://localhost/api/auth/login", { method: "POST", headers: { "content-type": "application/json", host: "localhost", "x-forwarded-for": "5.6.7.8" }, body: JSON.stringify(body) });

  it("a successful login persists one 'login' event for that member only", async () => {
    const res = await login(req({ memberId: "lukky", code: "0002" }));
    expect(res.status).toBe(200);
    expect(await actions("lukky")).toEqual(["login"]);
    expect(await actions("anni")).toEqual([]);
  });

  it("failed logins write nothing", async () => {
    expect((await login(req({ memberId: "anni", code: "9999" }))).status).toBe(401);
    expect(await actions()).toEqual([]);
  });

  it("a Sheets outage never blocks or fails a sign-in", async () => {
    sheets.failAll = googleError(503);
    const res = await login(req({ memberId: "rishii", code: "0003" }));
    expect(res.status).toBe(200);
  });

  it("a slow Sheets call cannot delay sign-in beyond a few seconds", async () => {
    sheets.appendValues = () => new Promise(() => {});
    const started = Date.now();
    const res = await login(req({ memberId: "anni", code: "0001" }));
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(4500);
  }, 10_000);
});

describe("meaningful actions are persisted per event type", () => {
  const input = { company: "Synthetic Co", jobRole: "Test Role", jobType: "Internship" as const, location: "Testville", jobUrl: "https://jobs.example.test/1" };

  it("add job, apply, update, un-apply and re-apply each write the right event once", async () => {
    const job = await createJob("anni", input, T0);
    await setApplicationStatus("anni", job.jobId, { status: "Applied" }, ms(1000));
    await setApplicationStatus("anni", job.jobId, { status: "Applied", notes: "hello" }, ms(2000));
    await setApplicationStatus("anni", job.jobId, { status: "Applied", notes: "hello" }, ms(3000)); // identical: no event
    await setApplicationStatus("anni", job.jobId, { status: "Not Applied" }, ms(4000));
    await setApplicationStatus("anni", job.jobId, { status: "Applied" }, ms(5000));
    expect(await actions("anni")).toEqual(["job_added", "job_applied", "application_updated", "job_unapplied", "job_applied"]);
  });

  it("a rejected duplicate job and a repeated identical update add no event (no duplicates from retries)", async () => {
    const job = await createJob("anni", input, T0);
    await expect(createJob("lukky", input, T0)).rejects.toMatchObject({ code: "duplicate_url" });
    await setApplicationStatus("anni", job.jobId, { status: "Applied" }, ms(1000));
    await setApplicationStatus("anni", job.jobId, { status: "Applied" }, ms(2000));
    expect(await actions()).toEqual(["job_added", "job_applied"]);
  });

  it("the timeline and summary come from the member's own persisted events only", async () => {
    const job = await createJob("anni", input, T0);
    await setApplicationStatus("anni", job.jobId, { status: "Applied" }, ms(1000));
    await setApplicationStatus("lukky", job.jobId, { status: "Applied" }, ms(2000));
    await recordVisit("rishii", ms(3000));

    const summary = async (who: "anni" | "lukky" | "rishii") => buildActivityTimeline((await getAnalyticsSource(who, ms(10_000))).activity, "2026-10-09").summary;
    expect(await summary("anni")).toMatchObject({ totalActions: 2, jobsAdded: 1, applied: 1, visits: 0 });
    expect(await summary("lukky")).toMatchObject({ totalActions: 1, jobsAdded: 0, applied: 1 });
    expect(await summary("rishii")).toMatchObject({ totalActions: 0, visits: 1 });
  });

  it("team contribution shows counts per member (jobs added + meaningful actions), nothing private", async () => {
    const a = await createJob("anni", input, T0);
    await createJob("lukky", { ...input, jobUrl: "https://jobs.example.test/2" }, T0);
    await setApplicationStatus("anni", a.jobId, { status: "Applied", notes: "anni-private-note" }, ms(1000));
    await recordVisit("rishii", ms(2000));
    const dash = await getDashboardData("rishii", ms(10_000));
    expect(dash.contribution.all.map((r) => [r.memberId, r.count, r.actions])).toEqual([["anni", 1, 2], ["lukky", 1, 1], ["rishii", 0, 0]]);
    expect(JSON.stringify(dash)).not.toContain("anni-private-note");
  });
});

describe("activity vs deleted jobs (no orphaned references)", () => {
  const input = (n: number) => ({ company: `Synthetic Co ${n}`, jobRole: `Test Role ${n}`, jobType: "Internship" as const, location: "Testville", jobUrl: `https://jobs.example.test/${n}` });

  it("deleting a job keeps the history but clears every reference to it", async () => {
    const a = await createJob("anni", input(1), T0);
    const b = await createJob("anni", input(2), T0);
    await setApplicationStatus("anni", a.jobId, { status: "Applied" }, ms(1000));
    await setApplicationStatus("anni", b.jobId, { status: "Applied" }, ms(2000));
    const before = (await readActivity()).items.length;
    await deleteJob("anni", a.jobId, ms(3000));
    const items = (await readActivity()).items;
    expect(items.length).toBe(before + 1); // history kept (plus the delete event)
    expect(items.some((i) => i.jobId === a.jobId)).toBe(false);
    expect(items.filter((i) => i.jobId === b.jobId)).toHaveLength(2); // the other job's rows untouched
  });

  it("scrubbing is bounded and tolerant of failures", async () => {
    const a = await createJob("anni", input(1), T0);
    expect(await scrubDeletedJobReferences([])).toBe(0);
    sheets.failAll = googleError(500);
    expect(await scrubDeletedJobReferences([a.jobId])).toBe(0);
    sheets.failAll = null;
    expect(await scrubDeletedJobReferences([a.jobId])).toBe(1);
    expect(await scrubDeletedJobReferences([a.jobId])).toBe(0); // already clean
  });
});

describe("failure handling", () => {
  it("an activity write failure after a successful action does not fail the action or claim success", async () => {
    const original = sheets.appendValues.bind(sheets);
    sheets.appendValues = async (range, rows) => {
      if (range.startsWith("Activity")) throw googleError(500);
      return original(range, rows);
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createJob("anni", { company: "C", jobRole: "R", jobType: "Internship", location: "L", jobUrl: "https://jobs.example.test/1" }, T0)).resolves.toBeDefined();
    expect(await actions()).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
