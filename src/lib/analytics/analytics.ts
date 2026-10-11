import { JOB_TYPES, type ApplicationStatus } from "@/types/domain";
import type {
  AnalyticsApplication, AnalyticsRange, AnalyticsResult, AnalyticsSource, Change, DistributionItem, StatCardData, TrendData,
} from "@/types/insights";
import { countApplications, type ApplicationCounts } from "@/lib/counting";
import { progressLevel } from "@/lib/follow-ups/progress";
import { buildActivityTimeline } from "./activity";
import { classifyDeadline, orderDeadlines } from "./deadlines";
import { addDays, diffDays, inRange, shortLabel, weekStart } from "./dates";

/** Statuses an application can be in once the member has applied. */
export const TRACKED_STATUSES: ApplicationStatus[] = ["Applied", "In Progress", "Interview", "Offer", "Rejected"];
/** The member got some kind of reply from the company. */
export const RESPONDED_STATUSES: ApplicationStatus[] = ["In Progress", "Interview", "Offer", "Rejected"];

const pct = (value: number, total: number) => (total > 0 ? Math.round((value / total) * 100) : 0);

function distribution(entries: [string, number][], total: number): DistributionItem[] {
  return entries.map(([label, value]) => ({ label, value, percent: pct(value, total) }));
}

function countBy<T>(items: T[], key: (item: T) => string): [string, number][] {
  const map = new Map<string, number>();
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface DateWindow {
  start: string;
  end: string;
  prev?: { start: string; end: string };
}

/** The window an analytics range covers, plus the previous equal-length window for comparisons. */
export function windowFor(range: AnalyticsRange, today: string, apps: AnalyticsApplication[]): DateWindow {
  if (range === "all") {
    const earliest = apps.reduce<string>((min, a) => (a.appliedDate < min ? a.appliedDate : min), today);
    return { start: earliest, end: today };
  }
  const start = addDays(today, -(range - 1));
  const prevEnd = addDays(start, -1);
  return { start, end: today, prev: { start: addDays(prevEnd, -(range - 1)), end: prevEnd } };
}

export function changeOf(current: number, previous: number, hasPrevious: boolean): Change {
  if (!hasPrevious) return { pct: null, direction: "none" };
  if (previous === 0) return current === 0 ? { pct: null, direction: "flat" } : { pct: null, direction: "new" };
  const p = Math.round(((current - previous) / previous) * 100);
  return { pct: Math.abs(p), direction: p > 0 ? "up" : p < 0 ? "down" : "flat" };
}

function buildTrend(apps: AnalyticsApplication[], win: DateWindow): TrendData {
  const days = diffDays(win.end, win.start) + 1;
  const weekly = days > 90;
  const ends: string[] = [];
  if (!weekly) {
    for (let i = 0; i < days; i++) ends.push(addDays(win.start, i));
  } else {
    for (let d = addDays(weekStart(win.start), 6); d < win.end; d = addDays(d, 7)) ends.push(d);
    ends.push(win.end);
  }
  const series = TRACKED_STATUSES.map((status) => {
    const mine = apps.filter((a) => a.status === status);
    return {
      key: status,
      label: status,
      // cumulative: applications of this (current) status applied on or before each bucket end
      values: ends.map((end) => mine.filter((a) => a.appliedDate <= end).length),
    };
  });
  return { labels: ends.map(shortLabel), series };
}

function buildDeadlines(source: AnalyticsSource) {
  const items = orderDeadlines(source.openDeadlines, source.today);
  const upcoming = source.openDeadlines.filter((d) => classifyDeadline(d.deadline, source.today).state !== "past");
  const days = upcoming.map((d) => classifyDeadline(d.deadline, source.today).days);
  const buckets: [string, number][] = [
    ["Within 3 days", days.filter((n) => n <= 3).length],
    ["4–7 days", days.filter((n) => n >= 4 && n <= 7).length],
    ["8–14 days", days.filter((n) => n >= 8 && n <= 14).length],
    ["15+ days", days.filter((n) => n >= 15).length],
  ];
  return {
    total: upcoming.length,
    buckets: distribution(buckets, upcoming.length),
    items,
    pastCount: source.openDeadlines.length - upcoming.length,
    noDeadline: source.noDeadlineCount,
  };
}

/**
 * Computes every Analytics figure from the member's own records for the chosen range.
 * Pure and deterministic: no randomness, no hardcoded demo numbers.
 */
export function computeAnalytics(source: AnalyticsSource, range: AnalyticsRange): AnalyticsResult {
  const { applications, today } = source;
  const win = windowFor(range, today, applications);
  const current = applications.filter((a) => inRange(a.appliedDate, win.start, win.end));
  const previous = win.prev ? applications.filter((a) => inRange(a.appliedDate, win.prev!.start, win.prev!.end)) : [];
  const hasPrev = Boolean(win.prev);
  const total = current.length;

  // Every card comes from the shared counting rules (src/lib/counting.ts), per window.
  const toCountable = (a: AnalyticsApplication) => ({ jobId: a.jobId, status: a.status, applicationStage: a.applicationStage, followUpAnswer: a.followUpAnswer });
  const nowCounts = countApplications(current.map(toCountable));
  const prevCounts = countApplications(previous.map(toCountable));
  const card = (key: StatCardData["key"], label: string, pick: (c: ApplicationCounts) => number): StatCardData => ({
    key,
    label,
    value: pick(nowCounts),
    change: changeOf(pick(nowCounts), pick(prevCounts), hasPrev),
  });

  const locationEntries = countBy(current, (a) => a.location);
  const topLocations = locationEntries.slice(0, 4);
  const otherLocations = locationEntries.slice(4).reduce((sum, [, n]) => sum + n, 0);
  if (otherLocations > 0) topLocations.push(["Other", otherLocations]);

  // A response is a status change from the company OR a saved Shortlisted/Interview/Offer progress.
  const responded = current.filter((a) => RESPONDED_STATUSES.includes(a.status) || progressLevel({ status: a.status, applicationStage: a.applicationStage }) >= 1).length;

  return {
    range,
    hasApplications: applications.length > 0,
    cards: [
      // Total Applications = every job available to the team (added by all members), never range-limited.
      { key: "total", label: "Total Applications", value: source.totalJobs, change: { pct: null, direction: "none" } },
      // Applied includes applications still pending: Pending is a subset, never added on top.
      card("applied", "Applied", (c) => c.applied),
      card("inProgress", "In Progress", (c) => c.inProgress),
      card("shortlisted", "Shortlisted", (c) => c.shortlisted),
      card("interviewed", "Interviewed", (c) => c.interviewed),
      card("offers", "Offers", (c) => c.offers),
      card("rejected", "Rejected", (c) => c.rejected),
    ],
    statusDistribution: distribution(
      TRACKED_STATUSES.map((s) => [s, current.filter((a) => a.status === s).length] as [string, number]),
      total,
    ),
    trend: buildTrend(current, win),
    response: { responded, total, percent: total > 0 ? pct(responded, total) : null },
    jobTypes: distribution(JOB_TYPES.map((t) => [t, current.filter((a) => a.jobType === t).length] as [string, number]), total),
    topCompanies: distribution(countBy(current, (a) => a.company).slice(0, 5), total),
    locations: distribution(topLocations, total),
    experience: distribution(countBy(current, (a) => a.experience || "Not specified").slice(0, 6), total),
    activity: buildActivityTimeline(source.activity, today, applications.map((a) => a.appliedDate), source.addedDates),
    deadlines: buildDeadlines(source),
  };
}
