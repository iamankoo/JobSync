import "server-only";
import type { MemberId } from "@/config/members";
import type { Application, FollowUpAnswer } from "@/types/domain";
import { applyFollowUpAnswer } from "@/lib/follow-ups/progress";
import { evaluateFollowUp } from "@/lib/follow-ups/rules";
import { nowIso } from "@/lib/utils/time";
import { recordActivity } from "./activity-service";
import { DomainError } from "./errors";
import { withWriteLock } from "./lock";
import { readApplicationsLocated, readJobs, updateApplicationRow } from "./repositories";

/** A follow-up question that is due for the signed-in member (real data only). */
export interface DueFollowUp {
  jobId: string;
  company: string;
  jobRole: string;
  location: string;
  /** ISO 8601 UTC: when the member applied (the timer origin). */
  appliedAt: string;
  /** ISO 8601 UTC: when the question became due (appliedAt + 168 h). */
  dueAt: string;
}

export interface FollowUpOverview {
  /** False when the Applications tab does not have the optional follow-up columns yet. */
  enabled: boolean;
  /** Oldest-due first. */
  due: DueFollowUp[];
  /** Applications skipped because their AppliedAt is missing/invalid (a safe diagnostic count). */
  invalid: number;
}

/**
 * Follow-ups due NOW for `memberId` (from the session). Eligibility is computed on the server from
 * UTC timestamps; nothing the browser says is used. Only the member's own applications are read.
 */
export async function getDueFollowUps(memberId: MemberId, now: Date = new Date()): Promise<FollowUpOverview> {
  const [jobs, apps] = await Promise.all([readJobs(), readApplicationsLocated()]);
  if (!apps.optionalColumns) return { enabled: false, due: [], invalid: 0 };

  const byId = new Map(jobs.items.map((j) => [j.jobId, j]));
  const due: DueFollowUp[] = [];
  let invalid = 0;
  for (const { value: app } of apps.items) {
    if (app.memberId !== memberId) continue;
    const job = byId.get(app.jobId);
    const verdict = evaluateFollowUp(app, job, now);
    if (verdict.state === "invalid") {
      invalid += 1;
      console.warn(`[follow-up] application skipped: ${verdict.reason} member=${memberId}`);
    } else if (verdict.state === "due" && job && app.appliedAt) {
      due.push({ jobId: job.jobId, company: job.company, jobRole: job.jobRole, location: job.location, appliedAt: app.appliedAt, dueAt: verdict.dueAt });
    }
  }
  due.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.jobId.localeCompare(b.jobId));
  return { enabled: true, due, invalid };
}

export interface FollowUpAnswerResult {
  jobId: string;
  answer: FollowUpAnswer;
  /** False when this exact answer had already been saved (a retry or a second tab). */
  changed: boolean;
  application: Application;
}

/**
 * Saves the signed-in member's answer to the follow-up for `jobId`.
 *  - Shortlisted: stage becomes "Shortlisted".   - Interview: status becomes "Interview".
 *  - Offer: status and stage become "Offer".        - No update: nothing else changes.
 *  In every case the answer + a server-generated UTC timestamp are stored in the same single row
 *  update, and an application is never moved to an earlier stage than it already has.
 * Retrying the same answer is a safe no-op (no double counting); a different answer after one was
 * saved is rejected so contradictory answers can never be recorded.
 */
export async function answerFollowUp(
  memberId: MemberId,
  jobId: string,
  answer: FollowUpAnswer,
  now: Date = new Date(),
): Promise<FollowUpAnswerResult> {
  const outcome = await withWriteLock(async () => {
    const [jobs, apps] = await Promise.all([readJobs({ fresh: true }), readApplicationsLocated({ fresh: true })]);
    if (!apps.optionalColumns) {
      throw new DomainError(
        "follow_ups_unavailable",
        "Follow-up questions are not enabled in the spreadsheet yet (the Applications tab needs the two follow-up columns).",
      );
    }
    // Only the caller's own row can ever be found here.
    const found = apps.items.find((i) => i.value.memberId === memberId && i.value.jobId === jobId);
    if (!found) throw new DomainError("follow_up_not_found", "There is no application to follow up on for that job.");
    const app = found.value;

    if (app.followUpAnswer) {
      if (app.followUpAnswer === answer) return { app, changed: false };
      throw new DomainError("follow_up_conflict", "This follow-up was already answered.", { answered: app.followUpAnswer });
    }

    const verdict = evaluateFollowUp(app, jobs.items.find((j) => j.jobId === jobId), now);
    if (verdict.state === "not_due") throw new DomainError("follow_up_not_due", "This follow-up is not due yet.", { dueAt: verdict.dueAt });
    if (verdict.state !== "due") {
      throw new DomainError("follow_up_not_applicable", "This follow-up no longer applies to the application.", { reason: verdict.reason });
    }

    const stamp = nowIso(now);
    // The answer and the resulting status/stage are written in ONE row update, so they can never
    // disagree. Status/stage only ever move forward (applyFollowUpAnswer never downgrades).
    const next: Application = { ...applyFollowUpAnswer(app, answer), followUpAnswer: answer, followUpAnsweredAt: stamp, lastUpdated: stamp };
    await updateApplicationRow(found.row, next, true);
    return { app: next, changed: true };
  });

  if (outcome.changed) await recordActivity(memberId, "follow_up_answered", jobId, now);
  return { jobId, answer, changed: outcome.changed, application: outcome.app };
}
