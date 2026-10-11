import type { Application, ApplicationStage, ApplicationStatus, FollowUpAnswer } from "@/types/domain";

/**
 * Where an application is in the pipeline, derived from its persisted status and stage. This is
 * the single definition used by the follow-up, the Dashboard and Analytics, so one application is
 * counted in exactly ONE progress category.
 *
 *   3 offer        status "Offer"      or stage "Offer"
 *   2 interview    status "Interview"  or stage Technical Interview / HR Interview / Final Round
 *   1 shortlisted  stage "Shortlisted"
 *   0 none
 *
 * The project's canonical values are reused: "Interview" and "Offer" are application statuses
 * (shown as "Interviewed" / "Offers" in Analytics); "Shortlisted" is an application stage.
 */
export type ProgressLevel = 0 | 1 | 2 | 3;

export const INTERVIEW_STAGES: readonly ApplicationStage[] = ["Technical Interview", "HR Interview", "Final Round"];

type ProgressInput = { status: ApplicationStatus; applicationStage?: ApplicationStage };

export function progressLevel(app: ProgressInput): ProgressLevel {
  if (app.status === "Offer" || app.applicationStage === "Offer") return 3;
  if (app.status === "Interview" || (app.applicationStage && INTERVIEW_STAGES.includes(app.applicationStage))) return 2;
  if (app.applicationStage === "Shortlisted") return 1;
  return 0;
}

export type ProgressCategory = "shortlisted" | "interview" | "offer";

/** The one category an application counts in, or null when it has not progressed beyond applied. */
export function progressCategory(app: ProgressInput): ProgressCategory | null {
  return ([null, "shortlisted", "interview", "offer"] as const)[progressLevel(app)];
}

/** What each follow-up answer asks the application to become (a *target*, never a downgrade). */
const TARGET: Record<FollowUpAnswer, { level: ProgressLevel; status?: ApplicationStatus; stage?: ApplicationStage }> = {
  Shortlisted: { level: 1, stage: "Shortlisted" },
  Interview: { level: 2, status: "Interview" },
  Offer: { level: 3, status: "Offer", stage: "Offer" },
  "No update": { level: 0 },
};

/**
 * Applies a follow-up answer to an application's status/stage WITHOUT ever moving it backwards:
 * if it is already at or beyond the answer's level, status and stage are left exactly as they are
 * (the answer itself is still recorded by the caller). "No update" never changes anything.
 */
export function applyFollowUpAnswer<T extends Pick<Application, "status" | "applicationStage">>(app: T, answer: FollowUpAnswer): T {
  const target = TARGET[answer];
  if (target.level === 0 || progressLevel(app) >= target.level) return app;
  return { ...app, status: target.status ?? app.status, applicationStage: target.stage ?? app.applicationStage };
}
