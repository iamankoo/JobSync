import "server-only";
import type { MemberId } from "@/config/members";
import type { ActivityAction } from "@/types/domain";
import { dateInTimezone, nowIso } from "@/lib/utils/time";
import { appTimezone } from "./config";
import { newId } from "./ids";
import { appendActivity } from "./repositories";

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
