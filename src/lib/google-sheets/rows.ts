import "server-only";
import { getMember, MEMBER_IDS, type MemberId } from "@/config/members";
import {
  ACTIVITY_ACTIONS,
  APPLICATION_STAGES,
  FOLLOW_UP_ANSWERS,
  APPLICATION_STATUSES,
  JOB_TYPES,
  WORK_MODES,
  type Activity,
  type Application,
  type Job,
  type MemberRecord,
  type NotificationLogRecord,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  type PushSubscriptionRecord,
} from "@/types/domain";
import { ID_PATTERN } from "@/lib/validation/applications";
import { parseHttpUrl } from "@/lib/utils/url";
import { isIsoDate, isIsoTimestamp } from "@/lib/utils/time";

/** Outcome of parsing one spreadsheet row. `warnings` are optional fields that were dropped. */
export type RowParse<T> = { ok: true; value: T; warnings: string[] } | { ok: false; problem: string };

const oneOf = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);
const isMemberId = (v: string): v is MemberId => (MEMBER_IDS as readonly string[]).includes(v);
const blank = (v: string | undefined) => (v ?? "").trim() === "";

// ---- Jobs ---------------------------------------------------------------

export function parseJobRow(cells: string[]): RowParse<Job> {
  const [jobId, company, jobRole, jobType, workMode, experience, stipendSalary, location, jobUrl, deadline, description, addedBy, addedAt] =
    cells.map((c) => c.trim());

  if (!ID_PATTERN.test(jobId)) return { ok: false, problem: "missing or invalid JobID" };
  if (!company) return { ok: false, problem: "missing Company" };
  if (!jobRole) return { ok: false, problem: "missing JobRole" };
  if (!oneOf(JOB_TYPES, jobType)) return { ok: false, problem: "missing or invalid JobType" };
  if (!location) return { ok: false, problem: "missing Location" };
  if (!parseHttpUrl(jobUrl)) return { ok: false, problem: "missing or invalid JobURL" };
  if (!isMemberId(addedBy)) return { ok: false, problem: "missing or unknown AddedBy" };
  if (!isIsoTimestamp(addedAt)) return { ok: false, problem: "missing or invalid AddedAt" };

  const warnings: string[] = [];
  const job: Job = { jobId, company, jobRole, jobType, location, jobUrl, addedBy, addedAt };
  if (workMode) {
    if (oneOf(WORK_MODES, workMode)) job.workMode = workMode;
    else warnings.push("ignored invalid WorkMode");
  }
  if (experience) job.experience = experience;
  if (stipendSalary) job.stipendSalary = stipendSalary;
  if (deadline) {
    if (isIsoDate(deadline)) job.deadline = deadline;
    else warnings.push("ignored invalid Deadline (expected YYYY-MM-DD)");
  }
  if (description) job.description = description;
  return { ok: true, value: job, warnings };
}

export function serializeJob(job: Job): string[] {
  return [
    job.jobId, job.company, job.jobRole, job.jobType, job.workMode ?? "", job.experience ?? "", job.stipendSalary ?? "",
    job.location, job.jobUrl, job.deadline ?? "", job.description ?? "", job.addedBy, job.addedAt,
  ];
}

// ---- Applications -------------------------------------------------------

export function parseApplicationRow(cells: string[]): RowParse<Application> {
  const [jobId, memberId, status, appliedAt, stage, notes, lastUpdated, followUp, followUpAt] = cells.map((c) => c.trim());

  if (!ID_PATTERN.test(jobId)) return { ok: false, problem: "missing or invalid JobID" };
  if (!isMemberId(memberId)) return { ok: false, problem: "missing or unknown MemberID" };
  if (!oneOf(APPLICATION_STATUSES, status)) return { ok: false, problem: "missing or invalid Status" };
  if (!isIsoTimestamp(lastUpdated)) return { ok: false, problem: "missing or invalid LastUpdated" };

  const warnings: string[] = [];
  const app: Application = { jobId, memberId, status, lastUpdated };
  if (appliedAt) {
    if (isIsoTimestamp(appliedAt)) app.appliedAt = appliedAt;
    else warnings.push("ignored invalid AppliedAt");
  }
  if (stage) {
    if (oneOf(APPLICATION_STAGES, stage)) app.applicationStage = stage;
    else warnings.push("ignored invalid ApplicationStage");
  }
  if (notes) app.notes = notes;
  if (followUp) {
    if (oneOf(FOLLOW_UP_ANSWERS, followUp) && followUpAt && isIsoTimestamp(followUpAt)) {
      app.followUpAnswer = followUp;
      app.followUpAnsweredAt = followUpAt;
    } else {
      warnings.push("ignored invalid follow-up answer (expected Shortlisted/Interview/Offer/No update with an ISO timestamp)");
    }
  }
  return { ok: true, value: app, warnings };
}

/**
 * `withFollowUp` = whether the sheet has the optional follow-up columns. Without them only the
 * seven core cells are written, so a sheet that has not been extended is never touched beyond G.
 */
export function serializeApplication(app: Application, withFollowUp = true): string[] {
  const core = [app.jobId, app.memberId, app.status, app.appliedAt ?? "", app.applicationStage ?? "", app.notes ?? "", app.lastUpdated];
  return withFollowUp ? [...core, app.followUpAnswer ?? "", app.followUpAnsweredAt ?? ""] : core;
}

// ---- Members ------------------------------------------------------------

const TRUE_VALUES = new Set(["true", "yes", "y", "1"]);
const FALSE_VALUES = new Set(["false", "no", "n", "0"]);

export function parseMemberRow(cells: string[]): RowParse<MemberRecord> {
  const [memberId, name, , active] = cells.map((c) => c.trim());
  if (!isMemberId(memberId)) return { ok: false, problem: "missing or unknown MemberID" };
  const flag = active.toLowerCase();
  if (!TRUE_VALUES.has(flag) && !FALSE_VALUES.has(flag)) return { ok: false, problem: "Active must be TRUE or FALSE" };

  const warnings: string[] = [];
  const canonical = getMember(memberId)!;
  // The app config is the single source of truth for identity; the tab mirrors it.
  if (name && name !== canonical.name) warnings.push("Name differs from the app configuration (configuration wins)");
  return {
    ok: true,
    value: { memberId, name: canonical.name, photo: canonical.photo, active: TRUE_VALUES.has(flag) },
    warnings,
  };
}

// ---- Activity -----------------------------------------------------------

export function parseActivityRow(cells: string[]): RowParse<Activity> {
  const [activityId, memberId, date, action, jobId, timestamp] = cells.map((c) => c.trim());
  if (!ID_PATTERN.test(activityId)) return { ok: false, problem: "missing or invalid ActivityID" };
  if (!isMemberId(memberId)) return { ok: false, problem: "missing or unknown MemberID" };
  if (!isIsoDate(date)) return { ok: false, problem: "missing or invalid Date" };
  if (!oneOf(ACTIVITY_ACTIONS, action)) return { ok: false, problem: "missing or invalid Action" };
  if (!isIsoTimestamp(timestamp)) return { ok: false, problem: "missing or invalid Timestamp" };
  const activity: Activity = { activityId, memberId, date, action, timestamp };
  if (!blank(jobId)) {
    if (!ID_PATTERN.test(jobId)) return { ok: false, problem: "invalid JobID" };
    activity.jobId = jobId;
  }
  return { ok: true, value: activity, warnings: [] };
}

export function serializeActivity(a: Activity): string[] {
  return [a.activityId, a.memberId, a.date, a.action, a.jobId ?? "", a.timestamp];
}

// ---- Push subscriptions -------------------------------------------------

export function parsePushSubscriptionRow(cells: string[]): RowParse<PushSubscriptionRecord> {
  const [subscriptionId, memberId, endpoint, p256dh, auth, createdAt, lastSeenAt] = cells.map((c) => c.trim());
  if (!ID_PATTERN.test(subscriptionId)) return { ok: false, problem: "missing or invalid SubscriptionID" };
  if (!isMemberId(memberId)) return { ok: false, problem: "missing or unknown MemberID" };
  if (!parseHttpUrl(endpoint)) return { ok: false, problem: "missing or invalid Endpoint" };
  if (!p256dh || !auth) return { ok: false, problem: "missing keys" };
  if (!isIsoTimestamp(createdAt)) return { ok: false, problem: "missing or invalid CreatedAt" };
  if (!isIsoTimestamp(lastSeenAt)) return { ok: false, problem: "missing or invalid LastSeenAt" };
  return { ok: true, value: { subscriptionId, memberId, endpoint, p256dh, auth, createdAt, lastSeenAt }, warnings: [] };
}

export function serializePushSubscription(s: PushSubscriptionRecord): string[] {
  return [s.subscriptionId, s.memberId, s.endpoint, s.p256dh, s.auth, s.createdAt, s.lastSeenAt];
}

// ---- Notification log ---------------------------------------------------

export function parseNotificationLogRow(cells: string[]): RowParse<NotificationLogRecord> {
  const [logKey, claimId, memberId, type, localDate, status, claimedAt, updatedAt, detail] = cells.map((c) => c.trim());
  if (!logKey) return { ok: false, problem: "missing LogKey" };
  if (!ID_PATTERN.test(claimId)) return { ok: false, problem: "missing or invalid ClaimID" };
  if (!isMemberId(memberId)) return { ok: false, problem: "missing or unknown MemberID" };
  if (!oneOf(NOTIFICATION_TYPES, type)) return { ok: false, problem: "missing or invalid Type" };
  if (!isIsoDate(localDate)) return { ok: false, problem: "missing or invalid LocalDate" };
  if (!oneOf(NOTIFICATION_STATUSES, status)) return { ok: false, problem: "missing or invalid Status" };
  if (!isIsoTimestamp(claimedAt)) return { ok: false, problem: "missing or invalid ClaimedAt" };
  if (!isIsoTimestamp(updatedAt)) return { ok: false, problem: "missing or invalid UpdatedAt" };
  return { ok: true, value: { logKey, claimId, memberId, type, localDate, status, claimedAt, updatedAt, detail }, warnings: [] };
}

export function serializeNotificationLog(r: NotificationLogRecord): string[] {
  return [r.logKey, r.claimId, r.memberId, r.type, r.localDate, r.status, r.claimedAt, r.updatedAt, r.detail];
}
