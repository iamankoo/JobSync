/**
 * 30-day retention rule. A job is kept for exactly 30 x 24 hours after its ORIGINAL, server-
 * generated `AddedAt` timestamp (UTC) and is then eligible for permanent deletion.
 *
 * Pure and safe on client and server. An invalid or missing timestamp NEVER counts as expired,
 * so malformed data can never cause anything to be deleted.
 */
export const RETENTION_DAYS = 30;
export const RETENTION_SECONDS = RETENTION_DAYS * 24 * 60 * 60; // 2,592,000

/** The instant a job stops being retained, or null when `addedAt` is not a valid ISO timestamp. */
export function retentionDeadline(addedAt: string | undefined): Date | null {
  if (!addedAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(addedAt)) return null;
  const ms = Date.parse(addedAt);
  return Number.isNaN(ms) ? null : new Date(ms + RETENTION_SECONDS * 1000);
}

/** True when `now` is at or after the job's retention deadline (inclusive). */
export function isExpired(addedAt: string | undefined, now: Date): boolean {
  const deadline = retentionDeadline(addedAt);
  return deadline !== null && now.getTime() >= deadline.getTime();
}

/** Whole days since the job was added (floored); null for invalid timestamps. */
export function ageInDays(addedAt: string | undefined, now: Date): number | null {
  if (!addedAt || retentionDeadline(addedAt) === null) return null;
  return Math.floor((now.getTime() - Date.parse(addedAt)) / 86_400_000);
}
