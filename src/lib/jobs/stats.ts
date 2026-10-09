import type { ApplicationStatus } from "@/types/domain";

/** Statuses where the member has applied but there is no final outcome yet. */
export const PENDING_STATUSES: readonly ApplicationStatus[] = ["Applied", "In Progress", "Interview"];

export interface JobCounts {
  total: number;
  /** Jobs the member has applied to (any status other than "Not Applied"). */
  applied: number;
  /** Applied and still awaiting a final outcome. */
  pending: number;
  notApplied: number;
}

/** Counts derived only from the given statuses, i.e. from real records of the signed-in member. */
export function countStatuses(statuses: ApplicationStatus[]): JobCounts {
  const total = statuses.length;
  const applied = statuses.filter((s) => s !== "Not Applied").length;
  const pending = statuses.filter((s) => PENDING_STATUSES.includes(s)).length;
  return { total, applied, pending, notApplied: total - applied };
}

/** The Applied/Not Applied indicator shown in All Jobs. */
export function isApplied(status: ApplicationStatus): boolean {
  return status !== "Not Applied";
}
