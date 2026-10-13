import "server-only";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import type { NotificationType } from "@/types/domain";
import { claimSlot, finishSlot, pruneLog } from "@/lib/google-sheets/notification-log-service";
import { appTimezone } from "@/lib/google-sheets/config";
import { isMemberActive } from "@/lib/google-sheets/members-service";
import { readJobs } from "@/lib/google-sheets/repositories";
import { dateInTimezone } from "@/lib/utils/time";
import { loadVapidConfig } from "./config";
import { countJobsAddedOn, inSlotWindow, morningPayload, nightPayload } from "./daily";
import { notifyMember } from "./notify";

export type MemberResult =
  | { memberId: MemberId; outcome: "sent"; delivered: number; devices: number; count?: number }
  | { memberId: MemberId; outcome: "already_sent" | "in_progress" | "inactive" | "no_subscription" | "delivery_failed" | "error" };

export type DailyRun =
  | { ran: false; reason: "outside_window" | "push_not_configured"; date: string }
  | { ran: true; type: NotificationType; date: string; timeZone: string; results: MemberResult[] };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sends the scheduled notification of `type` to each member, independently and exactly once per member and local
 * date. Reads Jobs (night only) and writes ONLY the PushSubscriptions (expired devices) and NotificationLog tabs;
 * it never modifies Jobs or Applications.
 *
 * Failure handling: a member's problem (Sheets hiccup, push outage) is logged by name only and recorded as
 * "failed" in the ledger so a re-run retries just that member; members already "sent" are never re-sent.
 * `now` is injectable so tests control the clock; `pause` lets tests skip the retry backoff.
 */
export async function runDailyNotifications(
  type: NotificationType,
  now: Date = new Date(),
  pause: (ms: number) => Promise<void> = sleep,
): Promise<DailyRun> {
  const timeZone = appTimezone();
  const date = dateInTimezone(now, timeZone);
  if (!loadVapidConfig()) return { ran: false, reason: "push_not_configured", date };
  if (!inSlotWindow(type, now, timeZone)) return { ran: false, reason: "outside_window", date };

  // The counts come from real persisted rows, read once. If this read fails nothing has been claimed yet,
  // so the whole run can simply be retried.
  const jobs = type === "night" ? (await readJobs({ fresh: true })).items : [];

  const results: MemberResult[] = [];
  for (const memberId of MEMBER_IDS) {
    results.push(await runForMember(type, memberId, date, timeZone, jobs, now, pause));
  }

  await pruneLog(date).catch((err) => console.error("[daily] log prune failed", err instanceof Error ? err.name : typeof err));
  return { ran: true, type, date, timeZone, results };
}

async function runForMember(
  type: NotificationType,
  memberId: MemberId,
  date: string,
  timeZone: string,
  jobs: Awaited<ReturnType<typeof readJobs>>["items"],
  now: Date,
  pause: (ms: number) => Promise<void>,
): Promise<MemberResult> {
  let claimId: string | null = null;
  try {
    if (!(await isMemberActive(memberId))) return { memberId, outcome: "inactive" };

    const claim = await claimSlot(type, memberId, date, now);
    if (!claim.claimed) return { memberId, outcome: claim.reason };
    claimId = claim.claimId;

    const count = type === "night" ? countJobsAddedOn(jobs, memberId, date, timeZone) : undefined;
    const payload = type === "morning" ? morningPayload(memberId, date) : nightPayload(memberId, date, count ?? 0);

    // Reading the subscription list can hit a transient Sheets error: try a few times before giving up.
    let outcome: Awaited<ReturnType<typeof notifyMember>> | null = null;
    for (let attempt = 0; attempt < 3 && !outcome; attempt++) {
      try {
        outcome = await notifyMember(memberId, payload);
      } catch (err) {
        console.error("[daily] could not load subscriptions", err instanceof Error ? err.name : typeof err);
        if (attempt < 2) await pause(500 * 2 ** attempt);
      }
    }
    if (!outcome) {
      await finishSlot(claimId, "failed", "subscriptions_unavailable", now);
      return { memberId, outcome: "error" };
    }
    if (outcome.attempted === 0) {
      // Nothing to deliver to yet; leave it retryable in case they enable notifications before the window ends.
      await finishSlot(claimId, "failed", "no_subscription", now);
      return { memberId, outcome: "no_subscription" };
    }
    if (outcome.delivered === 0) {
      await finishSlot(claimId, "failed", "delivery_failed", now);
      return { memberId, outcome: "delivery_failed" };
    }
    // At least one device got it: done. Re-sending would duplicate it on those devices.
    await finishSlot(claimId, "sent", `delivered ${outcome.delivered}/${outcome.attempted}`, now);
    return { memberId, outcome: "sent", delivered: outcome.delivered, devices: outcome.attempted, ...(count === undefined ? {} : { count }) };
  } catch (err) {
    console.error(`[daily] ${type} run failed for a member`, err instanceof Error ? err.name : typeof err);
    if (claimId) await finishSlot(claimId, "failed", "error", now).catch(() => undefined);
    return { memberId, outcome: "error" };
  }
}
