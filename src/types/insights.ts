import type { MemberId } from "@/config/members";
import type { ApplicationStage, ApplicationStatus, FollowUpAnswer, Job, JobType } from "@/types/domain";
import type { ActivityEvent, ActivityTimeline } from "@/lib/analytics/activity";
import type { DeadlineItem } from "@/lib/analytics/deadlines";

/** Daily target of new jobs each member should add. */
export const DAILY_TARGET = 10;

// ---- Dashboard ------------------------------------------------------------

export interface ContributionRow {
  memberId: MemberId;
  name: string;
  /** Jobs this member added in the period. */
  count: number;
  /** Meaningful actions this member performed in the period (visits and logins excluded). Team-wide figure: counts only. */
  actions: number;
}

export type ContributionPeriod = "week" | "month" | "all";

export interface DashboardData {
  totalJobs: number;
  /** Jobs the signed-in member has applied to (any status other than Not Applied). */
  myApplied: number;
  /** Applied, In Progress or Interview (no final outcome yet). */
  myPending: number;
  activeMemberCount: number;
  activeMemberNames: string[];
  /** Last 7 days, oldest first. */
  sparklines: { jobs: number[]; applications: number[]; pending: number[] };
  daily: {
    target: number;
    /** Jobs the signed-in member ADDED today (not applications). */
    addedToday: number;
    /** 0-100, capped. */
    percent: number;
    /** All counts below come from src/lib/counting.ts (one definition for every page). */
    applied: number;
    pending: number;
    shortlisted: number;
    interviewed: number;
    offers: number;
  };
  /** Jobs added per member (shared team summary; contains no application data). */
  contribution: Record<ContributionPeriod, ContributionRow[]>;
  recentJobs: { job: Job; applied: boolean }[];
  /** Jobs the member has not applied to that are still open, soonest deadline first. */
  upcomingDeadlines: { job: Job; daysLeft: number }[];
  today: string;
}

// ---- Analytics ------------------------------------------------------------

/** One of the signed-in member's applications joined with the job fields analytics needs. */
export interface AnalyticsApplication {
  jobId: string;
  status: ApplicationStatus;
  /** The persisted ApplicationStage (e.g. Shortlisted), when set. */
  applicationStage?: ApplicationStage;
  /** The member's saved 7-day follow-up answer, when there is one. */
  followUpAnswer?: FollowUpAnswer;
  /** YYYY-MM-DD in the display timezone: when the member applied. */
  appliedDate: string;
  company: string;
  jobType: JobType;
  location: string;
  experience?: string;
}

/**
 * Everything the Analytics page needs, scoped to ONE member: their own applications and
 * activity, plus open deadlines of shared jobs they have not applied to.
 */
export interface AnalyticsSource {
  applications: AnalyticsApplication[];
  /** ALL jobs in the shared Jobs sheet (added by every member). Not limited by the date range. */
  totalJobs: number;
  openDeadlines: { jobId: string; company: string; jobRole: string; deadline: string }[];
  /** Shared open jobs the member has not applied to that have NO (valid) deadline. */
  noDeadlineCount: number;
  /** The member's OWN persisted activity events (never other members'). */
  activity: ActivityEvent[];
  /** Calendar date (app timezone) of every job THIS member added, from the Jobs sheet. */
  addedDates: string[];
  today: string;
}

export type AnalyticsRange = 7 | 30 | 90 | "all";

export interface Change {
  /** Percentage change versus the previous equal-length window; null when it cannot be computed. */
  pct: number | null;
  direction: "up" | "down" | "flat" | "new" | "none";
}

export interface StatCardData {
  key: "total" | "applied" | "inProgress" | "shortlisted" | "interviewed" | "offers" | "rejected";
  label: string;
  value: number;
  change: Change;
}

export interface DistributionItem {
  label: string;
  value: number;
  percent: number;
}

export interface TrendData {
  labels: string[];
  series: { key: string; label: string; values: number[] }[];
}

export interface AnalyticsResult {
  range: AnalyticsRange;
  hasApplications: boolean;
  cards: StatCardData[];
  statusDistribution: DistributionItem[];
  trend: TrendData;
  response: { responded: number; total: number; percent: number | null };
  jobTypes: DistributionItem[];
  topCompanies: DistributionItem[];
  locations: DistributionItem[];
  experience: DistributionItem[];
  /** Last 13 weeks of the member's own activity, plus real summary figures. */
  activity: ActivityTimeline;
  deadlines: {
    /** Upcoming = due today or later. */
    total: number;
    buckets: DistributionItem[];
    /** Upcoming (soonest first) then the most recent past ones. */
    items: (DeadlineItem)[];
    pastCount: number;
    noDeadline: number;
  };
}
