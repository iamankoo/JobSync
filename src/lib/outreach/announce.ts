/**
 * Milestone notifications raised by JobSync's AUTOMATION (not by a member), delivered to every member's registered devices:
 *
 *   "10 connections added"  one notification per 10 Connections JobSync's import has SUCCESSFULLY CREATED (10, 20, 30, ...)
 *   "10 emails sent"        one notification per 10 CONFIRMED automated sends (10, 20, 30, ...)
 *
 * The two have independent counters and independent milestones. There is no per-Connection or per-email notification.
 *
 * What counts:
 *   connections  tracking rows from the Outreach Database import whose Connection was saved ("added") and CREATED by JobSync. Not counted:
 *                manual Connections, contacts that were already in Connections (linked), failed or unfinished imports, skipped /
 *                ineligible contacts. (A Connection a member later deletes still counts: JobSync did create it.)
 *   emails       Send Ledger rows "sent" with Gmail's message id, each recipient once (the same rule as the Sent counter).
 *
 * Exactly-once: each milestone is CLAIMED in the Outreach State tab before delivery (ordered append, first row wins; see
 * OutreachSheet.claimMilestone), delivered, then marked done. Cron retries and overlapping executions cannot announce it twice. If the
 * devices could not be reached the claim is released, so the next pass delivers it; if the process dies mid-way, the unfinished claim goes
 * stale after 10 minutes and is retried (a rare repeat is collapsed on the device by the notification tag). A human-readable progress row
 * ("<kind>-announced") records the highest milestone delivered. Delivery itself (opt-in device subscriptions, one notification per
 * device, expired-device cleanup, VAPID gate) is lib/push/notify.ts.
 */
import { randomUUID } from "node:crypto";
import { nowIso } from "@/lib/utils/time";
import { connectionsAddedPayload, emailsSentPayload, type PushPayload } from "@/lib/push/payload";
import type { OutreachSheet } from "./sheet";
import type { TrackingRecord } from "./types";

/** "done" = handled (delivered, or nothing could ever be delivered); "retry" = the devices could not be looked up, try again later. */
export type NotifyAll = (payload: PushPayload, eventKey: string) => Promise<"done" | "retry">;

export const MILESTONE_SIZE = 10;
/** Bounds the work of one cron call. */
export const MAX_ANNOUNCEMENTS_PER_RUN = 25;

export interface AnnounceDeps {
  sheet: Pick<OutreachSheet, "readTracking" | "readSendLedger" | "claimMilestone" | "completeMilestone" | "releaseMilestone" | "claimedMilestones" | "setState">;
  notify: NotifyAll;
  now: () => Date;
}

/** Connections JobSync's automation successfully created: the count behind "N connections added". */
export function importedConnectionCount(records: readonly TrackingRecord[]): number {
  return new Set(records.filter((r) => r.source === "outreach-database" && r.importStatus === "added" && r.connectionId && r.lastError !== "linked-existing").map((r) => r.contactId)).size;
}

/** Confirmed automated sends, each recipient once (same rule as the Sent counter). */
export function confirmedSendCount(ledger: readonly { status: string; sendKey: string; gmailMessageId: string }[]): number {
  return new Set(ledger.filter((r) => r.status === "sent" && r.gmailMessageId.trim() !== "").map((r) => r.sendKey)).size;
}

export interface MilestoneResult {
  announced: number;
  total: number;
  /** Highest milestone delivered so far. */
  announcedUpTo: number;
}

async function announceMilestones(deps: AnnounceDeps, kind: "connections" | "emails", total: number, payloadFor: (n: number) => PushPayload): Promise<MilestoneResult> {
  const result: MilestoneResult = { announced: 0, total, announcedUpTo: 0 };
  const claimed = await deps.sheet.claimedMilestones(nowIso(deps.now()));
  for (let n = MILESTONE_SIZE; n <= total; n += MILESTONE_SIZE) {
    if (claimed.has(`${kind}:${n}`)) {
      result.announcedUpTo = n;
      continue; // already announced (or being announced by another execution)
    }
    if (result.announced >= MAX_ANNOUNCEMENTS_PER_RUN) break;
    const claimId = randomUUID();
    if (!(await deps.sheet.claimMilestone(`${kind}:${n}`, claimId, nowIso(deps.now())))) {
      result.announcedUpTo = n;
      continue; // another execution got it first
    }
    const verdict = await deps.notify(payloadFor(n), `jobsync-${kind}-milestone:${n}`).catch((): "retry" => "retry");
    if (verdict === "retry") {
      await deps.sheet.releaseMilestone(`${kind}:${n}`, claimId, nowIso(deps.now())); // nothing delivered: a later pass may claim it again
      break;
    }
    await deps.sheet.completeMilestone(`${kind}:${n}`, claimId, nowIso(deps.now())); // durable "announced" record
    result.announced += 1;
    result.announcedUpTo = n;
    await deps.sheet.setState(`${kind}-announced`, String(n), nowIso(deps.now())).catch(() => undefined); // informational progress
  }
  return result;
}

/** "10 connections added", "20 connections added", ... */
export async function announceConnectionMilestones(deps: AnnounceDeps): Promise<MilestoneResult> {
  const { records } = await deps.sheet.readTracking();
  const total = importedConnectionCount(records);
  return announceMilestones(deps, "connections", total, (n) => connectionsAddedPayload(MILESTONE_SIZE, n));
}

/** "10 emails sent", "20 emails sent", ... */
export async function announceSentBlocks(deps: AnnounceDeps): Promise<MilestoneResult> {
  const { records } = await deps.sheet.readSendLedger();
  return announceMilestones(deps, "emails", confirmedSendCount(records), (n) => emailsSentPayload(MILESTONE_SIZE, n));
}
