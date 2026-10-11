import "server-only";
import { effectiveAppliedAt } from "@/lib/applications/applied-date";
import type { MemberId } from "@/config/members";
import type { Application } from "@/types/domain";
import type { AnalyticsSource, DashboardData } from "@/types/insights";
import { buildDashboard } from "@/lib/analytics/dashboard";
import { dateInTimezone } from "@/lib/utils/time";
import { appTimezone } from "./config";
import { readActivity, readApplications, readJobs, readMembers } from "./repositories";

const dateOf = (iso: string, timeZone: string) => dateInTimezone(new Date(iso), timeZone);

/** Only the signed-in member's own application rows. */
function own(apps: Application[], memberId: MemberId): Application[] {
  return apps.filter((a) => a.memberId === memberId);
}

/** Calendar date the member applied (see effectiveAppliedAt): recorded AppliedAt, else LastUpdated, else none. */
function appliedDateOf(a: { appliedAt?: string; lastUpdated: string }, timeZone: string): string | undefined {
  const { iso } = effectiveAppliedAt(a);
  return iso ? dateOf(iso, timeZone) : undefined;
}

/**
 * Dashboard data for `memberId` (taken from the session by the caller). Personal figures use only
 * that member's application rows; the team contribution summary uses only who added which job.
 */
export async function getDashboardData(memberId: MemberId, now: Date = new Date()): Promise<DashboardData> {
  const timeZone = appTimezone();
  const today = dateInTimezone(now, timeZone);
  const [jobs, apps, members, activity] = await Promise.all([readJobs(), readApplications(), readMembers(), readActivity()]);

  return buildDashboard({
    memberId,
    jobs: jobs.items,
    myApplications: own(apps.items, memberId).map((a) => ({
      jobId: a.jobId,
      status: a.status,
      applicationStage: a.applicationStage,
      followUpAnswer: a.followUpAnswer,
      appliedDate: appliedDateOf(a, timeZone),
    })),
    activeMembers: members.items.filter((m) => m.active).map((m) => m.memberId),
    // counts only: no job IDs or notes leave this function
    teamActivity: activity.items.map((a) => ({ memberId: a.memberId, date: a.date, action: a.action })),
    today,
    timeZone,
  });
}

/**
 * Analytics source for `memberId`: their own applications and activity, plus open deadlines of
 * shared jobs they have not applied to. Nothing about other members' applications is included.
 */
export async function getAnalyticsSource(memberId: MemberId, now: Date = new Date()): Promise<AnalyticsSource> {
  const timeZone = appTimezone();
  const today = dateInTimezone(now, timeZone);
  const [jobs, apps, activity] = await Promise.all([readJobs(), readApplications(), readActivity()]);

  const byId = new Map(jobs.items.map((j) => [j.jobId, j]));
  const mine = own(apps.items, memberId);
  const appliedIds = new Set(mine.filter((a) => a.status !== "Not Applied").map((a) => a.jobId));

  const applications: AnalyticsSource["applications"] = [];
  for (const a of mine) {
    const job = byId.get(a.jobId);
    if (!job || a.status === "Not Applied") continue;
    applications.push({
      jobId: a.jobId,
      status: a.status,
      applicationStage: a.applicationStage,
      followUpAnswer: a.followUpAnswer,
      appliedDate: appliedDateOf(a, timeZone) ?? dateOf(a.lastUpdated, timeZone),
      company: job.company,
      jobType: job.jobType,
      location: job.location,
      experience: job.experience,
    });
  }

  // Only THIS member's events leave this function.
  const events = activity.items.filter((row) => row.memberId === memberId).map((row) => ({ date: row.date, action: row.action, jobId: row.jobId, timestamp: row.timestamp }));
  const open = jobs.items.filter((j) => !appliedIds.has(j.jobId));

  return {
    applications,
    openDeadlines: open
      .filter((j) => j.deadline)
      .map((j) => ({ jobId: j.jobId, company: j.company, jobRole: j.jobRole, deadline: j.deadline! })),
    totalJobs: jobs.items.length,
    noDeadlineCount: open.filter((j) => !j.deadline).length,
    addedDates: jobs.items.filter((j) => j.addedBy === memberId).map((j) => dateOf(j.addedAt, timeZone)),
    activity: events,
    today,
  };
}
