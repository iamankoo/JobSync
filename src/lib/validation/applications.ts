import { z } from "zod";
import { APPLICATION_STAGES, APPLICATION_STATUSES, type ApplicationStatus } from "@/types/domain";

/**
 * Allowed status changes. A member with no Applications row is implicitly "Not Applied".
 * Moving to the same status is always allowed (e.g. to edit stage or notes).
 */
export const ALLOWED_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  "Not Applied": ["Applied"],
  Applied: ["Not Applied", "In Progress", "Interview", "Offer", "Rejected"],
  "In Progress": ["Interview", "Offer", "Rejected"],
  Interview: ["In Progress", "Offer", "Rejected"],
  Offer: ["Rejected"],
  Rejected: ["In Progress", "Interview"],
};

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * Body of PUT /api/applications/[jobId]. Strict: a `memberId` (or any unknown key) is rejected,
 * because identity comes only from the server-side session.
 */
export const updateApplicationSchema = z.strictObject({
  status: z.enum(APPLICATION_STATUSES),
  applicationStage: z.enum(APPLICATION_STAGES).nullable().optional(),
  notes: z.string().trim().max(1000, "Max 1000 characters").refine((v) => !CONTROL_CHARS.test(v), "Invalid characters").nullable().optional(),
});

export type UpdateApplicationInput = z.infer<typeof updateApplicationSchema>;

/** IDs are generated as `job_<uuid>` but hand-added IDs of this shape are tolerated. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const jobIdSchema = z.string().regex(ID_PATTERN, "Invalid job ID");
