import { MEMBERS, type MemberId } from "@/config/members";
import { dateInTimezone } from "@/lib/utils/time";
import type { ActivityAction, ApplicationStage, ApplicationStatus, FollowUpAnswer, Job } from "@/types/domain";
import { isMeaningful } from "./activity";
import { DAILY_TARGET, type ContributionPeriod, type ContributionRow, type DashboardData } from "@/types/insights";
import { daysUntil } from "@/lib/jobs/query";
import { countApplications, isApplied, isPending } from "@/lib/counting";
import { inRange, lastNDays, monthStart, weekStart } from "./dates";

export interface DashboardInput {
  memberId: MemberId;
  /** All valid shared jobs. */
  jobs: Job[];
  /** The signed-in member's own application statuses and applied dates (YYYY-MM-DD), keyed by job. */
  myApplications: { jobId: string; status: ApplicationStatus; applicationStage?: ApplicationStage; followUpAnswer?: FollowUpAnswer; appliedDate?: string }[];
  /** Members marked Active in the Members tab. */
  activeMembers: MemberId[];
  /** Every member's persisted events, used ONLY for team-wide meaningful-action counts. */
  teamActivity?: TeamActivity[];
  today: string;
  timeZone: string;
}

/** Day a job was added, in the display timezone. */
export function addedDate(job: Job, timeZone: string): string {
  return dateInTimezone(new Date(job.addedAt), timeZone);
}

/** One persisted event, reduced to what the team summary needs (no job IDs, no notes). */
export interface TeamActivity {
  memberId: MemberId;
  date: string;
  action: ActivityAction;
}

/**
 * Team-wide summary per member: jobs added (from the Jobs sheet's AddedBy/AddedAt) and meaningful
 * actions (from the Activity sheet; visits/logins excluded). Counts only: nothing private.
 */
export function contributionFor(jobs: Job[], timeZone: string, activity: TeamActivity[], from?: string, to?: string): ContributionRow[] {
  const inPeriod = (date: string) => !from || !to || inRange(date, from, to);
  return MEMBERS.map((m) => ({
    memberId: m.id,
    name: m.name,
    count: jobs.filter((j) => j.addedBy === m.id && inPeriod(addedDate(j, timeZone))).length,
    actions: activity.filter((a) => a.memberId === m.id && isMeaningful(a.action) && inPeriod(a.date)).length,
  }));
}

/**
 * Builds the Dashboard from real records. Personal numbers use ONLY `myApplications`
 * (the signed-in member's rows); the team summary uses only who added which job.
 */
export function buildDashboard(input: DashboardInput): DashboardData {
  const { memberId, jobs, myApplications, activeMembers, today, timeZone } = input;
  const teamActivity = input.teamActivity ?? [];
  // Only applications whose job still exists count (a deleted/expired job leaves no phantom application).
  const jobIds = new Set(jobs.map((j) => j.jobId));
  const known = myApplications.filter((a) => jobIds.has(a.jobId));
  const counts = countApplications(known.map((a) => ({ jobId: a.jobId, status: a.status, applicationStage: a.applicationStage, followUpAnswer: a.followUpAnswer })));
  const applied = known.filter(isApplied);
  const pending = applied.filter(isPending);

  const days7 = lastNDays(today, 7);
  const perDay = (dates: (string | undefined)[]) => days7.map((d) => dates.filter((x) => x === d).length);

  const addedToday = jobs.filter((j) => j.addedBy === memberId && addedDate(j, timeZone) === today).length;
  const week = weekStart(today);

  const mine = new Map(known.map((a) => [a.jobId, a.status]));
  const appliedSet = (jobId: string) => (mine.get(jobId) ?? "Not Applied") !== "Not Applied";

  const recentJobs = [...jobs]
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .slice(0, 5)
    .map((job) => ({ job, applied: appliedSet(job.jobId) }));

  const upcomingDeadlines = jobs
    .filter((j) => j.deadline && daysUntil(j.deadline, today) >= 0 && !appliedSet(j.jobId))
    .sort((a, b) => a.deadline!.localeCompare(b.deadline!) || a.addedAt.localeCompare(b.addedAt))
    .slice(0, 5)
    .map((job) => ({ job, daysLeft: daysUntil(job.deadline!, today) }));

  const contribution: Record<ContributionPeriod, ContributionRow[]> = {
    week: contributionFor(jobs, timeZone, teamActivity, week, today),
    month: contributionFor(jobs, timeZone, teamActivity, monthStart(today), today),
    all: contributionFor(jobs, timeZone, teamActivity),
  };

  const activeSet = new Set(activeMembers);
  const active = MEMBERS.filter((m) => activeSet.has(m.id));

  return {
    totalJobs: jobs.length,
    myApplied: counts.applied,
    myPending: counts.pending,
    activeMemberCount: active.length,
    activeMemberNames: active.map((m) => m.name),
    sparklines: {
      jobs: perDay(jobs.map((j) => addedDate(j, timeZone))),
      applications: perDay(applied.map((a) => a.appliedDate)),
      pending: perDay(pending.map((a) => a.appliedDate)),
    },
    daily: {
      target: DAILY_TARGET,
      addedToday,
      percent: Math.min(100, Math.round((addedToday / DAILY_TARGET) * 100)),
      applied: counts.applied,
      pending: counts.pending,
      shortlisted: counts.shortlisted,
      interviewed: counts.interviewed,
      offers: counts.offers,
    },
    contribution,
    recentJobs,
    upcomingDeadlines,
    today,
  };
}
