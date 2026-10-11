import type { ApplicationStatus } from "@/types/domain";

/**
 * The binary Applied / Not Applied indicator used by the All Jobs status toggle.
 * All COUNTS live in src/lib/counting.ts (the single source of truth).
 */
export function isApplied(status: ApplicationStatus): boolean {
  return status !== "Not Applied";
}
