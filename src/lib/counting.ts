import type { ApplicationStage, ApplicationStatus, FollowUpAnswer } from "@/types/domain";
import { progressLevel } from "@/lib/follow-ups/progress";

/**
 * THE single source of truth for every application count in JobSync (All Jobs, Dashboard,
 * Analytics, My Applications). It works on one member's application records only, using the
 * existing canonical model:
 *
 *   Status  = whether the member applied, plus the outcome:  Not Applied | Applied | In Progress |
 *             Interview | Offer | Rejected
 *   Stage   = progress after applying:  Shortlisted, interview rounds, Offer, ...
 *   (the pipeline  Not Applied -> Applied/Pending -> Shortlisted -> Interview -> Offer  is read
 *    from Status and Stage together by `progressLevel`; Rejected is the Rejected status)
 *
 * Counting rules (each application is counted at most once in each category):
 *   applied      distinct jobs the member marked Applied (status other than Not Applied).
 *                "Total Applications" is this same number: Pending is INCLUDED, never added on top.
 *   pending      applied, with no known outcome yet: not Rejected and not at Offer. A subset of applied.
 *   inProgress   status "In Progress" (a subset of pending).
 *   shortlisted  pipeline position is Shortlisted (stage "Shortlisted", not yet at interview/offer).
 *   interviewed  pipeline position is Interview (status Interview or an interview-round stage).
 *   offers       pipeline position is Offer (status Offer or stage Offer).
 *   rejected     status "Rejected", OR the 7-day follow-up was answered "No update yet" and the application
 *                never reached Shortlisted/Interview/Offer (not shortlisted after follow-up = rejected).
 *                Such an application is no longer pending.
 *   notApplied   shared jobs the member has not applied to = total jobs - applied.
 * Missing or unknown stages never count towards shortlisted / interviewed / offers.
 */
export interface CountableApplication {
  jobId: string;
  status: ApplicationStatus;
  applicationStage?: ApplicationStage;
  /** The member's saved answer to the 7-day follow-up, when there is one. */
  followUpAnswer?: FollowUpAnswer;
}

export interface ApplicationCounts {
  applied: number;
  pending: number;
  inProgress: number;
  shortlisted: number;
  interviewed: number;
  offers: number;
  rejected: number;
}

const PENDING_STATUSES: readonly ApplicationStatus[] = ["Applied", "In Progress", "Interview"];

/** Not shortlisted after the 7-day follow-up: answered "No update yet" and never advanced. */
export function isRejectedByFollowUp(app: Pick<CountableApplication, "status" | "applicationStage" | "followUpAnswer">): boolean {
  return app.followUpAnswer === "No update" && progressLevel(app) < 1;
}

export function isRejected(app: Pick<CountableApplication, "status" | "applicationStage" | "followUpAnswer">): boolean {
  return app.status === "Rejected" || isRejectedByFollowUp(app);
}

/** Applied with no known outcome yet. */
export function isPending(app: Pick<CountableApplication, "status" | "applicationStage" | "followUpAnswer">): boolean {
  return PENDING_STATUSES.includes(app.status) && progressLevel(app) < 3 && !isRejectedByFollowUp(app);
}

export function isApplied(app: Pick<CountableApplication, "status">): boolean {
  return app.status !== "Not Applied";
}

export const EMPTY_COUNTS: ApplicationCounts = { applied: 0, pending: 0, inProgress: 0, shortlisted: 0, interviewed: 0, offers: 0, rejected: 0 };

/** Counts one member's applications. Duplicate records for the same job are counted once. */
export function countApplications(apps: CountableApplication[]): ApplicationCounts {
  const seen = new Set<string>();
  const counts = { ...EMPTY_COUNTS };
  for (const app of apps) {
    if (!isApplied(app) || seen.has(app.jobId)) continue;
    seen.add(app.jobId);
    counts.applied += 1;
    if (isPending(app)) counts.pending += 1;
    if (app.status === "In Progress") counts.inProgress += 1;
    if (isRejected(app)) counts.rejected += 1;
    const level = progressLevel(app);
    if (level === 1) counts.shortlisted += 1;
    else if (level === 2) counts.interviewed += 1;
    else if (level === 3) counts.offers += 1;
  }
  return counts;
}

/** Shared jobs the member has not applied to. Never negative. */
export function notAppliedCount(totalJobs: number, applied: number): number {
  return Math.max(0, totalJobs - applied);
}
