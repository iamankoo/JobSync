/**
 * Flags kept in the free-text `detail` of a draft-ledger row (NF_Drafts), as "; "-separated parts:
 *   "attached: <file>"   the resume the draft carries
 *   "review: <reason>"   the drafting step flagged the draft for a person (e.g. no verified resume, research unavailable)
 *   "parked: <reason>"   the SEND step looked at the draft, found it cannot be sent (opted out, invalid recipient, duplicate, wrong/missing
 *                        resume, content check failed ...) and recorded why. The draft itself is NEVER touched in Gmail.
 *
 * A review/parked draft stays in the member's Gmail exactly as it is and is never discarded, but it is not part of the ELIGIBLE backlog that
 * the draft-backlog gate counts (otherwise drafts that need a person could pause new drafting forever). It is counted and reported separately.
 */
export const PARKED_PREFIX = "parked:";
const REVIEW_PREFIX = "review:";
const parts = (detail: string) => detail.split("; ").map((p) => p.trim()).filter(Boolean);

export const hasReviewFlag = (detail: string) => parts(detail).some((p) => p.startsWith(REVIEW_PREFIX));

/** The reason this draft was parked by the send step, or null when it is not parked. */
export const parkedReasonOf = (detail: string): string | null => {
  const p = parts(detail).find((x) => x.startsWith(PARKED_PREFIX));
  return p ? p.slice(PARKED_PREFIX.length).trim() : null;
};

/** Needs a person (flagged at creation or parked by the send step): untouched in Gmail, not part of the eligible backlog. */
export const isParkedDetail = (detail: string) => hasReviewFlag(detail) || parkedReasonOf(detail) !== null;

/** Normalised reason text as stored (no separators, bounded), so the same reason always compares equal. */
export const normalizeParkReason = (reason: string) => reason.replace(/\s*;\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, 160);

/** The detail with the parked marker set to `reason` (or removed when null). Every other part is kept as is. */
export function withParkedReason(detail: string, reason: string | null): string {
  const kept = parts(detail).filter((p) => !p.startsWith(PARKED_PREFIX));
  return [...kept, ...(reason ? [`${PARKED_PREFIX} ${normalizeParkReason(reason)}`] : [])].join("; ");
}
