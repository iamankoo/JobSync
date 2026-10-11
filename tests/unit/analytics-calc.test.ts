import { describe, expect, it } from "vitest";
import { addDays, diffDays, lastNDays, monthStart, weekStart, weekdayIndex } from "@/lib/analytics/dates";
import { buildDashboard } from "@/lib/analytics/dashboard";
import { changeOf, computeAnalytics, windowFor } from "@/lib/analytics/analytics";
import type { ApplicationStatus, Job, JobType } from "@/types/domain";
import type { AnalyticsApplication, AnalyticsSource } from "@/types/insights";
import { DAILY_TARGET } from "@/types/insights";
import { makeJob } from "../helpers/fixtures";

const TODAY = "2026-10-09"; // a Friday
const TZ = "Asia/Kolkata";

describe("date helpers", () => {
  it("adds and diffs days across month boundaries", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(diffDays("2026-10-09", "2026-09-29")).toBe(10);
  });
  it("lists the last N days oldest first", () => {
    expect(lastNDays(TODAY, 3)).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
  });
  it("finds the Monday-based week and month start", () => {
    expect(weekdayIndex("2026-10-05")).toBe(0); // Monday
    expect(weekdayIndex("2026-10-11")).toBe(6); // Sunday
    expect(weekStart("2026-10-09")).toBe("2026-10-05");
    expect(weekStart("2026-10-05")).toBe("2026-10-05");
    expect(monthStart("2026-10-09")).toBe("2026-10-01");
  });
});

const jobAt = (n: number, over: Partial<Job> = {}): Job =>
  makeJob(n, { addedBy: "anni", addedAt: `${TODAY}T05:00:00.000Z`, deadline: undefined, ...over });

describe("buildDashboard", () => {
  const base = { memberId: "anni" as const, activeMembers: ["anni", "lukky", "rishii"] as ("anni" | "lukky" | "rishii")[], today: TODAY, timeZone: TZ };

  it("is all zeros and empty for an empty database (no invented numbers)", () => {
    const d = buildDashboard({ ...base, jobs: [], myApplications: [] });
    expect(d.totalJobs).toBe(0);
    expect(d.myApplied).toBe(0);
    expect(d.myPending).toBe(0);
    expect(d.daily).toEqual({ target: DAILY_TARGET, addedToday: 0, percent: 0, applied: 0, pending: 0, shortlisted: 0, interviewed: 0, offers: 0 });
    expect(d.recentJobs).toEqual([]);
    expect(d.upcomingDeadlines).toEqual([]);
    expect(d.sparklines.jobs).toEqual([0, 0, 0, 0, 0, 0, 0]);
    for (const period of ["week", "month", "all"] as const) expect(d.contribution[period].map((r) => r.count)).toEqual([0, 0, 0]);
    expect(d.contribution.all.map((r) => r.name)).toEqual(["Anni", "Lukky", "Rishii"]);
  });

  it("daily target counts only the member's own jobs added today, capped at 100%", () => {
    const jobs = [
      ...Array.from({ length: 3 }, (_, i) => jobAt(i + 1)),
      jobAt(10, { addedBy: "lukky" }), // someone else's job today: not mine
      jobAt(11, { addedAt: "2026-10-08T05:00:00.000Z" }), // mine, but yesterday
    ];
    const d = buildDashboard({ ...base, jobs, myApplications: [] });
    expect(d.daily).toMatchObject({ target: 10, addedToday: 3, percent: 30 });
    const many = Array.from({ length: 12 }, (_, i) => jobAt(i + 1));
    expect(buildDashboard({ ...base, jobs: many, myApplications: [] }).daily).toMatchObject({ addedToday: 12, percent: 100 });
  });

  it("'today' uses the display timezone, not UTC", () => {
    // 20:00 UTC on the 8th is 01:30 IST on the 9th => counts as today in Asia/Kolkata
    const j = jobAt(1, { addedAt: "2026-10-08T20:00:00.000Z" });
    expect(buildDashboard({ ...base, jobs: [j], myApplications: [] }).daily.addedToday).toBe(1);
    expect(buildDashboard({ ...base, timeZone: "UTC", jobs: [j], myApplications: [] }).daily.addedToday).toBe(0);
  });

  it("personal numbers come only from the member's own application rows", () => {
    const jobs = Array.from({ length: 6 }, (_, i) => jobAt(i + 1));
    const mine: { jobId: string; status: ApplicationStatus; appliedDate?: string }[] = [
      { jobId: "job_1", status: "Applied", appliedDate: TODAY },
      { jobId: "job_2", status: "In Progress", appliedDate: TODAY },
      { jobId: "job_3", status: "Interview", appliedDate: "2026-10-08" },
      { jobId: "job_4", status: "Offer" },
      { jobId: "job_5", status: "Rejected" },
      { jobId: "job_6", status: "Not Applied" },
    ];
    const d = buildDashboard({ ...base, jobs, myApplications: mine });
    expect(d.myApplied).toBe(5); // everything except Not Applied
    expect(d.myPending).toBe(3); // Applied, In Progress, Interview: no known outcome (Offer and Rejected have one)
    expect(d.daily).toMatchObject({ applied: 5, pending: 3, shortlisted: 0, interviewed: 1, offers: 1 });
    expect(d.sparklines.applications.at(-1)).toBe(2); // today
    expect(d.sparklines.applications.at(-2)).toBe(1); // yesterday
    expect(d.totalJobs).toBe(6);
  });

  it("the same shared jobs give different personal numbers to different members", () => {
    const jobs = [jobAt(1), jobAt(2)];
    const anni = buildDashboard({ ...base, jobs, myApplications: [{ jobId: "job_1", status: "Applied" }] });
    const lukky = buildDashboard({ ...base, memberId: "lukky", jobs, myApplications: [] });
    expect(anni.totalJobs).toBe(lukky.totalJobs);
    expect(anni.myApplied).toBe(1);
    expect(lukky.myApplied).toBe(0);
    expect(anni.recentJobs.find((r) => r.job.jobId === "job_1")?.applied).toBe(true);
    expect(lukky.recentJobs.find((r) => r.job.jobId === "job_1")?.applied).toBe(false);
  });

  it("team contribution counts jobs per member for this week, this month and all time", () => {
    const jobs = [
      jobAt(1, { addedBy: "anni", addedAt: "2026-10-09T05:00:00.000Z" }), // this week
      jobAt(2, { addedBy: "anni", addedAt: "2026-10-05T05:00:00.000Z" }), // Monday this week
      jobAt(3, { addedBy: "lukky", addedAt: "2026-10-04T05:00:00.000Z" }), // Sunday: previous week, this month
      jobAt(4, { addedBy: "rishii", addedAt: "2026-09-20T05:00:00.000Z" }), // last month
    ];
    const d = buildDashboard({ ...base, jobs, myApplications: [] });
    const counts = (p: "week" | "month" | "all") => Object.fromEntries(d.contribution[p].map((r) => [r.memberId, r.count]));
    expect(counts("week")).toEqual({ anni: 2, lukky: 0, rishii: 0 });
    expect(counts("month")).toEqual({ anni: 2, lukky: 1, rishii: 0 });
    expect(counts("all")).toEqual({ anni: 2, lukky: 1, rishii: 1 });
  });

  it("recent jobs: five newest first; upcoming deadlines: soonest first, open and not yet applied", () => {
    const jobs = Array.from({ length: 7 }, (_, i) => jobAt(i + 1, { addedAt: `2026-10-0${i + 1}T05:00:00.000Z`, deadline: addDays(TODAY, 7 - i - 1) }));
    // job_1 deadline +6 ... job_7 deadline 0 (today). Mark job_7 as applied: it must drop out of deadlines.
    const d = buildDashboard({ ...base, jobs, myApplications: [{ jobId: "job_7", status: "Applied" }] });
    expect(d.recentJobs.map((r) => r.job.jobId)).toEqual(["job_7", "job_6", "job_5", "job_4", "job_3"]);
    expect(d.upcomingDeadlines.map((u) => u.job.jobId)).toEqual(["job_6", "job_5", "job_4", "job_3", "job_2"]);
    expect(d.upcomingDeadlines.map((u) => u.daysLeft)).toEqual([1, 2, 3, 4, 5]);
  });

  it("past deadlines and jobs without deadlines are not 'upcoming'", () => {
    const jobs = [jobAt(1, { deadline: "2026-10-08" }), jobAt(2), jobAt(3, { deadline: TODAY })];
    expect(buildDashboard({ ...base, jobs, myApplications: [] }).upcomingDeadlines.map((u) => u.job.jobId)).toEqual(["job_3"]);
  });

  it("team member count reflects the Members tab's active flags", () => {
    const d = buildDashboard({ ...base, activeMembers: ["anni", "rishii"], jobs: [], myApplications: [] });
    expect(d.activeMemberCount).toBe(2);
    expect(d.activeMemberNames).toEqual(["Anni", "Rishii"]);
  });
});

const app = (jobId: string, status: ApplicationStatus, appliedDate: string, over: Partial<AnalyticsApplication> = {}): AnalyticsApplication => ({
  jobId, status, appliedDate, company: "Synthetic Co A", jobType: "Full-time" as JobType, location: "Testville", experience: "0–1 years", ...over,
});
const source = (applications: AnalyticsApplication[], over: Partial<AnalyticsSource> = {}): AnalyticsSource => ({
  applications, totalJobs: applications.length, openDeadlines: [], noDeadlineCount: 0, activity: [], addedDates: [], today: TODAY, ...over,
});

describe("computeAnalytics", () => {
  it("empty source: zeros, null response rate, no applications flag, empty distributions", () => {
    const r = computeAnalytics(source([]), 30);
    expect(r.hasApplications).toBe(false);
    expect(r.cards.map((c) => c.value)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(r.response).toEqual({ responded: 0, total: 0, percent: null });
    expect(r.topCompanies).toEqual([]);
    expect(r.locations).toEqual([]);
    expect(r.experience).toEqual([]);
    expect(r.statusDistribution.every((d) => d.value === 0 && d.percent === 0)).toBe(true);
    expect(r.activity.summary.totalActions).toBe(0);
    expect(r.deadlines).toMatchObject({ total: 0, items: [], pastCount: 0, noDeadline: 0 });
  });

  it("counts cards and status distribution for the window only", () => {
    const apps = [
      app("1", "Applied", "2026-10-08"), app("2", "Applied", "2026-10-01"), app("3", "In Progress", "2026-09-20"),
      app("4", "Interview", "2026-09-15"), app("5", "Offer", "2026-09-12"), app("6", "Rejected", "2026-08-01"), // outside 30d
    ];
    const r = computeAnalytics(source(apps), 30);
    // Applied = ALL applications marked applied (pending included, never added on top)
    expect(r.cards.map((c) => [c.key, c.value])).toEqual([
      ["total", 6], ["applied", 5], ["inProgress", 1], ["shortlisted", 0], ["interviewed", 1], ["offers", 1], ["rejected", 0],
    ]);
    expect(r.statusDistribution.map((d) => [d.label, d.value, d.percent])).toEqual([
      ["Applied", 2, 40], ["In Progress", 1, 20], ["Interview", 1, 20], ["Offer", 1, 20], ["Rejected", 0, 0],
    ]);
    expect(computeAnalytics(source(apps), "all").cards[1].value).toBe(6);
    expect(computeAnalytics(source(apps), 7).cards[1].value).toBe(1);
    // Total Applications is the shared total of all jobs: it does not follow the date range
    expect(computeAnalytics(source(apps, { totalJobs: 40 }), 7).cards[0]).toMatchObject({ key: "total", value: 40 });
  });

  it("compares with the previous equal window; 'all time' has no comparison", () => {
    const apps = [
      app("1", "Applied", "2026-10-05"), app("2", "Applied", "2026-10-06"), app("3", "Applied", "2026-10-07"), // current 7d: 3
      app("4", "Applied", "2026-09-30"), app("5", "Applied", "2026-10-01"), // previous 7d (Oct 3.. wait): see window below
    ];
    const w = windowFor(7, TODAY, apps);
    expect(w).toEqual({ start: "2026-10-03", end: TODAY, prev: { start: "2026-09-26", end: "2026-10-02" } });
    const r = computeAnalytics(source(apps), 7);
    expect(r.cards[1]).toMatchObject({ key: "applied", value: 3, change: { pct: 50, direction: "up" } }); // prev = 2 (09-30, 10-01)
    expect(computeAnalytics(source(apps), "all").cards[1].change).toEqual({ pct: null, direction: "none" });
  });

  it("change calculation covers up, down, flat, new and none", () => {
    expect(changeOf(6, 4, true)).toEqual({ pct: 50, direction: "up" });
    expect(changeOf(2, 4, true)).toEqual({ pct: 50, direction: "down" });
    expect(changeOf(4, 4, true)).toEqual({ pct: 0, direction: "flat" });
    expect(changeOf(3, 0, true)).toEqual({ pct: null, direction: "new" });
    expect(changeOf(0, 0, true)).toEqual({ pct: null, direction: "flat" });
    expect(changeOf(3, 1, false)).toEqual({ pct: null, direction: "none" });
  });

  it("response rate counts anything past 'Applied' as a response", () => {
    const apps = [app("1", "Applied", "2026-10-08"), app("2", "In Progress", "2026-10-08"), app("3", "Interview", "2026-10-08"), app("4", "Rejected", "2026-10-08")];
    expect(computeAnalytics(source(apps), 30).response).toEqual({ responded: 3, total: 4, percent: 75 });
  });

  it("trend is cumulative per status with one point per day in the window", () => {
    const apps = [app("1", "Applied", "2026-10-07"), app("2", "Applied", "2026-10-09"), app("3", "Rejected", "2026-10-08")];
    const t = computeAnalytics(source(apps), 7).trend;
    expect(t.labels).toHaveLength(7);
    expect(t.labels.at(-1)).toBe("9 Oct");
    const values = (key: string) => t.series.find((s) => s.key === key)!.values;
    expect(values("Applied")).toEqual([0, 0, 0, 0, 1, 1, 2]);
    expect(values("Rejected")).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(values("Offer").every((v) => v === 0)).toBe(true);
    // cumulative values never decrease
    for (const s of t.series) for (let i = 1; i < s.values.length; i++) expect(s.values[i]).toBeGreaterThanOrEqual(s.values[i - 1]);
  });

  it("long ranges switch to weekly points so the chart stays readable", () => {
    const apps = [app("1", "Applied", "2026-01-05")];
    const t = computeAnalytics(source(apps), "all").trend;
    expect(t.labels.length).toBeLessThan(60);
    expect(t.series[0].values.at(-1)).toBe(1);
  });

  it("job types always list every type; companies are top 5; locations group the rest as Other; experience falls back to 'Not specified'", () => {
    const apps = [
      ...Array.from({ length: 3 }, (_, i) => app(`a${i}`, "Applied", TODAY, { company: "Co A", jobType: "Internship", location: "L1", experience: undefined })),
      ...Array.from({ length: 2 }, (_, i) => app(`b${i}`, "Applied", TODAY, { company: "Co B", jobType: "Full-time", location: "L2" })),
      app("c", "Applied", TODAY, { company: "Co C", location: "L3" }),
      app("d", "Applied", TODAY, { company: "Co D", location: "L4" }),
      app("e", "Applied", TODAY, { company: "Co E", location: "L5" }),
      app("f", "Applied", TODAY, { company: "Co F", location: "L6" }),
    ];
    const r = computeAnalytics(source(apps), 30);
    expect(r.jobTypes.map((d) => [d.label, d.value])).toEqual([["Internship", 3], ["Full-time", 6], ["Part-time", 0], ["Contract", 0]]);
    expect(r.topCompanies).toHaveLength(5);
    expect(r.topCompanies[0]).toMatchObject({ label: "Co A", value: 3 });
    expect(r.topCompanies[1]).toMatchObject({ label: "Co B", value: 2 });
    expect(r.locations.map((d) => d.label)).toEqual(["L1", "L2", "L3", "L4", "Other"]);
    expect(r.locations.at(-1)?.value).toBe(2); // L5 + L6
    expect(r.experience.find((d) => d.label === "Not specified")?.value).toBe(3);
    expect(r.locations.reduce((s, d) => s + d.value, 0)).toBe(9);
  });

  it("deadlines overview buckets only upcoming deadlines", () => {
    const d = (n: number, days: number) => ({ jobId: `j${n}`, company: "C", jobRole: "R", deadline: addDays(TODAY, days) });
    const r = computeAnalytics(source([], { openDeadlines: [d(1, -2), d(2, 0), d(3, 3), d(4, 4), d(5, 7), d(6, 8), d(7, 14), d(8, 15), d(9, 40)] }), 30);
    expect(r.deadlines.total).toBe(8); // the past one is excluded
    expect(r.deadlines.buckets.map((b) => [b.label, b.value])).toEqual([["Within 3 days", 2], ["4–7 days", 2], ["8–14 days", 2], ["15+ days", 2]]);
    expect(r.deadlines.buckets.every((b) => b.percent === 25)).toBe(true);
  });

  it("is deterministic: same input, same output", () => {
    const apps = [app("1", "Applied", "2026-10-08"), app("2", "Interview", "2026-10-02")];
    expect(computeAnalytics(source(apps), 30)).toEqual(computeAnalytics(source(apps), 30));
  });
});
