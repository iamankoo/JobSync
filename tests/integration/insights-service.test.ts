import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { createJob } from "@/lib/google-sheets/jobs-service";
import { setApplicationStatus } from "@/lib/google-sheets/applications-service";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { getAnalyticsSource, getDashboardData } from "@/lib/google-sheets/insights-service";
import { computeAnalytics } from "@/lib/analytics/analytics";
import type { CreateJobInput } from "@/lib/validation/jobs";
import { FakeSheets } from "../helpers/fake-sheets";

let sheets: FakeSheets;
const NOW = new Date("2026-10-09T10:00:00.000Z");
const input = (n: number, over: Partial<CreateJobInput> = {}): CreateJobInput => ({
  company: `Synthetic Co ${n}`, jobRole: `Test Role ${n}`, jobType: "Internship", location: "Testville", experience: "0–1 years",
  jobUrl: `https://jobs.example.test/${n}`, ...over,
});

beforeEach(() => {
  sheets = new FakeSheets().seedMembers();
  setSheetsClientForTesting(sheets);
  resetMembersCache();
});
afterEach(() => setSheetsClientForTesting(null));

describe("Dashboard data from the sheet", () => {
  it("an empty database yields real zeros and empty lists", async () => {
    const d = await getDashboardData("anni", NOW);
    expect(d).toMatchObject({ totalJobs: 0, myApplied: 0, myPending: 0, activeMemberCount: 3, recentJobs: [], upcomingDeadlines: [] });
    expect(d.daily).toMatchObject({ addedToday: 0, percent: 0, target: 10 });
  });

  it("totals and team contribution are shared; personal figures are scoped to the signed-in member", async () => {
    const a = await createJob("anni", input(1, { deadline: "2026-10-20" }), NOW);
    const b = await createJob("lukky", input(2, { deadline: "2026-10-12" }), NOW);
    await createJob("rishii", input(3), NOW);
    await setApplicationStatus("anni", a.jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("anni", b.jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("anni", b.jobId, { status: "Interview" }, NOW);
    await setApplicationStatus("lukky", a.jobId, { status: "Applied" }, NOW);

    const anni = await getDashboardData("anni", NOW);
    const lukky = await getDashboardData("lukky", NOW);
    const rishii = await getDashboardData("rishii", NOW);

    for (const d of [anni, lukky, rishii]) {
      expect(d.totalJobs).toBe(3);
      expect(Object.fromEntries(d.contribution.all.map((r) => [r.memberId, r.count]))).toEqual({ anni: 1, lukky: 1, rishii: 1 });
    }
    expect(anni).toMatchObject({ myApplied: 2, myPending: 2 });
    expect(anni.daily).toMatchObject({ addedToday: 1, applied: 2, shortlisted: 0, interviewed: 1, offers: 0 });
    expect(lukky).toMatchObject({ myApplied: 1, myPending: 1 });
    expect(lukky.daily).toMatchObject({ addedToday: 1, shortlisted: 0 });
    expect(rishii).toMatchObject({ myApplied: 0, myPending: 0 });
    // recent jobs show only MY applied flag
    expect(anni.recentJobs.find((r) => r.job.jobId === a.jobId)?.applied).toBe(true);
    expect(rishii.recentJobs.every((r) => r.applied === false)).toBe(true);
    // upcoming deadlines exclude what I already applied to
    expect(anni.upcomingDeadlines).toEqual([]);
    expect(rishii.upcomingDeadlines.map((u) => u.job.jobId)).toEqual([b.jobId, a.jobId]);
  });

  it("deactivating a member in the Members tab lowers the team member count", async () => {
    sheets.rows("Members")[3][3] = "FALSE"; // rishii
    expect((await getDashboardData("anni", NOW)).activeMemberCount).toBe(2);
  });

  it("malformed rows are ignored rather than crashing the dashboard", async () => {
    await createJob("anni", input(1), NOW);
    sheets.rows("Jobs").push(["job_bad", "", "", "x", "", "", "", "", "", "", "", "", ""]);
    sheets.rows("Applications").push(["job_x", "eve", "Applied", "", "", "", "2026-10-09T10:00:00.000Z"]);
    const d = await getDashboardData("anni", NOW);
    expect(d.totalJobs).toBe(1);
    expect(d.myApplied).toBe(0);
  });
});

describe("Analytics data from the sheet", () => {
  it("contains only the signed-in member's applications and activity", async () => {
    const a = await createJob("anni", input(1), NOW);
    const b = await createJob("lukky", input(2), NOW);
    await setApplicationStatus("anni", a.jobId, { status: "Applied", notes: "anni-private" }, NOW);
    await setApplicationStatus("lukky", a.jobId, { status: "Applied", notes: "lukky-private" }, NOW);
    await setApplicationStatus("lukky", b.jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("lukky", b.jobId, { status: "Rejected" }, NOW);

    const anni = await getAnalyticsSource("anni", NOW);
    const lukky = await getAnalyticsSource("lukky", NOW);
    const rishii = await getAnalyticsSource("rishii", NOW);

    expect(anni.applications.map((x) => [x.jobId, x.status])).toEqual([[a.jobId, "Applied"]]);
    expect(lukky.applications.map((x) => [x.jobId, x.status]).sort()).toEqual([[a.jobId, "Applied"], [b.jobId, "Rejected"]].sort());
    expect(rishii.applications).toEqual([]);
    for (const s of [anni, lukky, rishii]) {
      const text = JSON.stringify(s);
      if (s !== anni) expect(text).not.toContain("anni-private");
      if (s !== lukky) expect(text).not.toContain("lukky-private");
    }
    // activity: each member sees only their own counts
    expect(anni.activity.map((e) => e.action)).toEqual(["job_added", "job_applied"]);
    expect(anni.activity.every((e) => e.date === "2026-10-09")).toBe(true);
    expect(rishii.activity).toEqual([]);
  });

  it("computes real numbers end to end from the sheet", async () => {
    const jobs = [];
    for (let i = 1; i <= 4; i++) jobs.push(await createJob("anni", input(i, { jobType: i % 2 ? "Full-time" : "Internship", location: i < 3 ? "Testville" : "Remote" }), NOW));
    await setApplicationStatus("anni", jobs[0].jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("anni", jobs[1].jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("anni", jobs[1].jobId, { status: "Interview" }, NOW);
    await setApplicationStatus("anni", jobs[2].jobId, { status: "Applied" }, NOW);
    await setApplicationStatus("anni", jobs[2].jobId, { status: "Rejected" }, NOW);

    const r = computeAnalytics(await getAnalyticsSource("anni", NOW), 30);
    expect(r.cards.map((c) => [c.key, c.value])).toEqual([
      ["total", 4], ["applied", 3], ["inProgress", 0], ["shortlisted", 0], ["interviewed", 1], ["offers", 0], ["rejected", 1],
    ]);
    expect(r.response).toEqual({ responded: 2, total: 3, percent: 67 });
    expect(r.jobTypes.find((t) => t.label === "Full-time")?.value).toBe(2);
    expect(r.locations.map((l) => [l.label, l.value])).toEqual([["Testville", 2], ["Remote", 1]]);
  });

  it("open deadlines are shared jobs the member has not applied to", async () => {
    const a = await createJob("lukky", input(1, { deadline: "2026-10-12" }), NOW);
    await createJob("lukky", input(2, { deadline: "2026-10-30" }), NOW);
    await createJob("lukky", input(3), NOW); // no deadline
    await setApplicationStatus("anni", a.jobId, { status: "Applied" }, NOW);
    expect((await getAnalyticsSource("anni", NOW)).openDeadlines.map((d) => d.deadline)).toEqual(["2026-10-30"]);
    expect((await getAnalyticsSource("rishii", NOW)).openDeadlines.map((d) => d.deadline).sort()).toEqual(["2026-10-12", "2026-10-30"]);
  });

  it("applications to jobs that no longer exist are not counted", async () => {
    const a = await createJob("anni", input(1), NOW);
    await setApplicationStatus("anni", a.jobId, { status: "Applied" }, NOW);
    sheets.rows("Jobs").splice(1, 1);
    expect((await getAnalyticsSource("anni", NOW)).applications).toEqual([]);
  });
});
