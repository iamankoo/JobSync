import { isIsoTimestamp } from "@/lib/utils/time";

/**
 * THE one place that decides "when did the member apply?" for reporting (Dashboard, Analytics, the
 * Application Timeline's Job Applied count).
 *
 *  recorded  the server-recorded `AppliedAt` (always preferred).
 *  fallback  legacy rows hand-made or written before `AppliedAt` existed: the row's `LastUpdated`
 *            is the best available date (it is never earlier than the real application date).
 *  unknown   neither is a valid timestamp: no date is invented.
 *
 * The 7-day follow-up deliberately does NOT use this: it needs the true `AppliedAt`, and a row
 * without one is never prompted (see evaluateFollowUp -> "missing_applied_at").
 */
export type AppliedDateSource = "recorded" | "fallback" | "unknown";

export function effectiveAppliedAt(app: { appliedAt?: string; lastUpdated?: string }): { iso?: string; source: AppliedDateSource } {
  if (app.appliedAt && isIsoTimestamp(app.appliedAt)) return { iso: app.appliedAt, source: "recorded" };
  if (app.lastUpdated && isIsoTimestamp(app.lastUpdated)) return { iso: app.lastUpdated, source: "fallback" };
  return { source: "unknown" };
}
