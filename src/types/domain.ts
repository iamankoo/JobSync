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
  "Shortlisted",
  "Online Assessment",
  "Screening",
  "Technical Interview",
  "HR Interview",
  "Final Round",
  "Offer",
  "Closed",
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

export const ACTIVITY_ACTIONS = [
  "job_added", "job_applied", "job_unapplied", "application_updated", "job_updated", "job_deleted", "follow_up_answered",
  // presence events (not work): a successful sign-in, and a server-validated page visit (max once / 30 min)
  "login", "visit",
] as const;

/** Answers to "What's the current status of this application?" (asked 168 hours after applying). */
export const FOLLOW_UP_ANSWERS = ["Shortlisted", "Interview", "Offer", "No update"] as const;
export type FollowUpAnswer = (typeof FOLLOW_UP_ANSWERS)[number];
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
  /** The member's answer to the 7-day status follow-up; absent while unanswered. */
  followUpAnswer?: FollowUpAnswer;
  /** ISO 8601 UTC, server-generated when the follow-up was answered. */
  followUpAnsweredAt?: string;
}

/** A shared job plus the CALLER's own status. Other members' statuses are never included. */
export interface JobWithMyStatus extends Job {
  myStatus: ApplicationStatus;
  /** The caller's own application stage for this job, when set. */
  myStage?: ApplicationStage;
  myFollowUpAnswer?: FollowUpAnswer;
}

/** One of the caller's own applications joined with its (shared) job. */
export interface MyApplicationRow {
  job: Job;
  application: Application;
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

/** One browser Web Push subscription belonging to a member's device. Secret: never sent to browsers or logged. */
export interface PushSubscriptionRecord {
  /** Stable, log-safe ID derived from the endpoint. */
  subscriptionId: string;
  memberId: MemberId;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** ISO 8601 UTC. */
  lastSeenAt: string;
}

export const NOTIFICATION_TYPES = ["morning", "night"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export const NOTIFICATION_STATUSES = ["claimed", "sent", "failed"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** One attempt to send a member's scheduled notification for a local date. */
export interface NotificationLogRecord {
  /** `<type>:<memberId>:<localDate>` — the idempotency key. */
  logKey: string;
  /** Unique per attempt. */
  claimId: string;
  memberId: MemberId;
  type: NotificationType;
  /** Calendar date (YYYY-MM-DD) in the app timezone. */
  localDate: string;
  status: NotificationStatus;
  claimedAt: string;
  updatedAt: string;
  /** Short machine-readable note (never contains endpoints or keys). */
  detail: string;
}

// ---- Connections --------------------------------------------------------

export const CONNECTION_STATUSES = ["Not Connected", "Connected", "Messaged", "Reply"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** A person a member wants to connect with, and the message to send them. Private to its owner. */
export interface Connection {
  connectionId: string;
  memberId: MemberId;
  name: string;
  company?: string;
  role?: string;
  /** Contact email address. */
  email?: string;
  /** LinkedIn / profile URL (http/https only). */
  profileUrl?: string;
  /** Any other useful profile or contact URL (http/https only). */
  otherUrl?: string;
  /** Suggested message to send. */
  message?: string;
  notes?: string;
  status: ConnectionStatus;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** ISO 8601 UTC. */
  updatedAt: string;
}

// ---- Group chat ---------------------------------------------------------

export const CHAT_KINDS = ["text", "file", "voice", "call"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

export interface ChatMessage {
  messageId: string;
  memberId: MemberId;
  kind: ChatKind;
  /** The message text; for a call event, a short description. Empty for bare attachments. */
  text: string;
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationSec?: number;
  /** ISO 8601 UTC. */
  createdAt: string;
}

export const CALL_SIGNAL_TYPES = ["start", "join", "offer", "answer", "leave", "ping", "end"] as const;
export type CallSignalType = (typeof CALL_SIGNAL_TYPES)[number];

export interface CallSignal {
  signalId: string;
  callId: string;
  from: MemberId;
  /** Addressee; absent = everyone in the call. */
  to?: MemberId;
  type: CallSignalType;
  /** Small JSON string (an SDP description, or call metadata). */
  payload: string;
  /** ISO 8601 UTC. */
  createdAt: string;
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
