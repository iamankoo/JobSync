import type { MemberId } from "@/config/members";

export const JOB_TYPES = ["Internship", "Full-time", "Part-time", "Contract"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const WORK_MODES = ["Remote", "Hybrid", "On-site"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const APPLICATION_STATUSES = [
  "Not Applied",
  "Applied",
  "In Progress",
  "Interview",
  "Offer",
  "Rejected",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_STAGES = [
  "Submitted",
  "Online Assessment",
  "Screening",
  "Technical Interview",
  "HR Interview",
  "Final Round",
  "Offer",
  "Closed",
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

export const ACTIVITY_ACTIONS = ["job_added", "job_applied", "application_updated"] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export interface Job {
  jobId: string;
  company: string;
  jobRole: string;
  jobType: JobType;
  workMode?: WorkMode;
  experience?: string;
  stipendSalary?: string;
  location: string;
  jobUrl: string;
  /** Calendar date, YYYY-MM-DD. */
  deadline?: string;
  description?: string;
  addedBy: MemberId;
  /** ISO 8601 UTC timestamp. */
  addedAt: string;
}

export interface Application {
  jobId: string;
  memberId: MemberId;
  status: ApplicationStatus;
  /** ISO 8601 UTC; present once the member has applied. */
  appliedAt?: string;
  applicationStage?: ApplicationStage;
  notes?: string;
  /** ISO 8601 UTC. */
  lastUpdated: string;
}

export interface Activity {
  activityId: string;
  memberId: MemberId;
  /** Calendar date (YYYY-MM-DD) in the configured app timezone. */
  date: string;
  action: ActivityAction;
  jobId?: string;
  /** ISO 8601 UTC. */
  timestamp: string;
}

export interface MemberRecord {
  memberId: MemberId;
  name: string;
  photo: string;
  active: boolean;
}

/** A row-level problem found while reading a tab. Contains no cell contents beyond identifiers. */
export interface RowIssue {
  tab: string;
  /** 1-based spreadsheet row number. */
  row: number;
  problem: string;
}

export interface ReadResult<T> {
  items: T[];
  issues: RowIssue[];
}
