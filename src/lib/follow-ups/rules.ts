import type { Application, ApplicationStage, ApplicationStatus } from "@/types/domain";
import { isExpired } from "@/lib/retention/rules";
import { progressLevel } from "./progress";

/**
 * 7-day shortlisting follow-up.
 *
 *  - The timer starts when the server records an application as Applied; `AppliedAt` (UTC,
 *    server-generated, kept across note/stage edits, cleared by Not Applied) is its origin.
 *  - 168 hours = 7 x 24 hours = 604,800 seconds. The follow-up is due when
 *    `now >= AppliedAt + 604,800 s`, evaluated on the server in UTC.
 */
export const FOLLOW_UP_AFTER_HOURS = 168;
export const FOLLOW_UP_AFTER_SECONDS = FOLLOW_UP_AFTER_HOURS * 60 * 60; // 604,800

/** Only applications still waiting for an outcome are asked. */
export const FOLLOW_UP_STATUSES: readonly ApplicationStatus[] = ["Applied", "In Progress"];

/**
 * Stages that end the question: the member is already at Interview/Offer or the process is closed.
 * (A merely "Shortlisted" application IS still asked, because it may have moved on since.)
 */
export const SUPPRESSING_STAGES: readonly ApplicationStage[] = ["Technical Interview", "HR Interview", "Final Round", "Offer", "Closed"];

export type SuppressedReason = "not_applied" | "status" | "stage" | "answered" | "job_missing" | "job_expired";
export type InvalidReason = "missing_applied_at" | "invalid_applied_at";

export type FollowUpVerdict =
  | { state: "due"; dueAt: string }
  | { state: "not_due"; dueAt: string }
  | { state: "suppressed"; reason: SuppressedReason }
  | { state: "invalid"; reason: InvalidReason };

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** When the follow-up becomes due, or null if `appliedAt` is missing or not a valid UTC timestamp. */
export function followUpDueAt(appliedAt: string | undefined): Date | null {
  if (!appliedAt || !ISO_UTC.test(appliedAt)) return null;
  const ms = Date.parse(appliedAt);
  return Number.isNaN(ms) ? null : new Date(ms + FOLLOW_UP_AFTER_SECONDS * 1000);
}

type AppLike = Pick<Application, "status" | "appliedAt" | "applicationStage" | "followUpAnswer">;

/**
 * Decides whether a member's application needs the follow-up question right now.
 * `job` is undefined when the job no longer exists; it carries `addedAt` for the retention check
 * (a job past its 30-day lifetime is never asked about, so follow-ups cannot extend its life).
 *
 * Recovery policy for bad data: a missing/invalid `AppliedAt` is reported as `invalid` and the
 * prompt is NOT shown; fix the timestamp in the sheet, or mark the job Not Applied and Applied again.
 */
export function evaluateFollowUp(app: AppLike, job: { addedAt: string } | undefined, now: Date): FollowUpVerdict {
  if (app.status === "Not Applied") return { state: "suppressed", reason: "not_applied" };
  if (!FOLLOW_UP_STATUSES.includes(app.status)) return { state: "suppressed", reason: "status" };
  if (app.followUpAnswer) return { state: "suppressed", reason: "answered" };
  if ((app.applicationStage && SUPPRESSING_STAGES.includes(app.applicationStage)) || progressLevel({ status: app.status, applicationStage: app.applicationStage }) >= 2) {
    return { state: "suppressed", reason: "stage" };
  }
  if (!job) return { state: "suppressed", reason: "job_missing" };
  if (isExpired(job.addedAt, now)) return { state: "suppressed", reason: "job_expired" };
  if (!app.appliedAt) return { state: "invalid", reason: "missing_applied_at" };
  const due = followUpDueAt(app.appliedAt);
  if (!due) return { state: "invalid", reason: "invalid_applied_at" };
  return now.getTime() >= due.getTime() ? { state: "due", dueAt: due.toISOString() } : { state: "not_due", dueAt: due.toISOString() };
}
