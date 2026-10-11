import "server-only";
import type { MemberId } from "@/config/members";
import type { ActivityAction } from "@/types/domain";
import { dateInTimezone, nowIso } from "@/lib/utils/time";
import { appTimezone } from "./config";
import { newId } from "./ids";
import { isPresence } from "@/lib/analytics/activity";
import { withWriteLock } from "./lock";
import { appendActivity, readActivityLocated, updateActivityRow } from "./repositories";

/**
 * Records a successful action for the authenticated member. Best effort: the primary write has
 * already succeeded, so a failure here is logged (without secrets) and does not fail the request.
 * Only IDs, the action name and timestamps are stored.
 */
export async function recordActivity(
  memberId: MemberId,
  action: ActivityAction,
  jobId?: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    await appendActivity({
      activityId: newId("act"),
      memberId,
      date: dateInTimezone(now, appTimezone()),
      action,
      jobId,
      timestamp: nowIso(now),
    });
  } catch (err) {
    console.error(`[sheets] activity not recorded action=${action} member=${memberId}`, (err as Error).name);
  }
}

/** A visit is recorded at most once per member per 30 minutes (see recordVisit). */
export const VISIT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Records a server-validated page visit for `memberId` (the caller has already validated the
 * session). DEDUPLICATION RULE: at most ONE visit/login per member per 30-minute window, judged
 * from the member's latest persisted presence event, so page navigation, refreshes, the 30-second
 * background refresh and several tabs never add a row each. Returns true only if a row was
 * actually written; failures are logged and reported as not recorded.
 */
export async function recordVisit(memberId: MemberId, now: Date = new Date()): Promise<boolean> {
  try {
    return await withWriteLock(async () => {
      const { items } = await readActivityLocated({ fresh: true });
      let last = 0;
      for (const { value: a } of items) {
        if (a.memberId === memberId && isPresence(a.action)) last = Math.max(last, Date.parse(a.timestamp));
      }
      if (last && now.getTime() - last < VISIT_WINDOW_MS) return false;
      await appendActivity({
        activityId: newId("act"), memberId, date: dateInTimezone(now, appTimezone()), action: "visit", timestamp: nowIso(now),
      });
      return true;
    });
  } catch (err) {
    console.error("[sheets] visit not recorded", err instanceof Error ? err.name : typeof err);
    return false;
  }
}

/** Waits for `work`, but never longer than `ms`: activity logging must not slow a sign-in. */
export async function withinMs<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clears the JobID of Activity rows that point at deleted jobs, so history is kept but nothing
 * references a job that no longer exists. Best effort and bounded; returns how many rows changed.
 */
export async function scrubDeletedJobReferences(jobIds: string[], limit = 500): Promise<number> {
  if (jobIds.length === 0) return 0;
  const gone = new Set(jobIds);
  try {
    const { items } = await readActivityLocated({ fresh: true });
    let changed = 0;
    for (const { row, value } of items) {
      if (changed >= limit) break;
      if (value.jobId && gone.has(value.jobId)) {
        await updateActivityRow(row, { ...value, jobId: undefined });
        changed += 1;
      }
    }
    return changed;
  } catch (err) {
    console.error("[sheets] could not clear deleted job references from Activity", err instanceof Error ? err.name : typeof err);
    return 0;
  }
}
