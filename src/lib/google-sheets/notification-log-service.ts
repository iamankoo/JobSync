import "server-only";
import { randomUUID } from "node:crypto";
import type { MemberId } from "@/config/members";
import type { NotificationLogRecord, NotificationStatus, NotificationType } from "@/types/domain";
import { addDays } from "@/lib/analytics/dates";
import { nowIso } from "@/lib/utils/time";
import { withWriteLock } from "./lock";
import { appendNotificationLog, deleteTabRows, readNotificationLogLocated, updateNotificationLogRow } from "./repositories";

/** A claim younger than this counts as "another run is working on it". */
export const CLAIM_LEASE_MS = 5 * 60_000;
/** Ledger rows older than this many days are pruned. */
export const LOG_KEEP_DAYS = 14;

export const logKeyFor = (type: NotificationType, memberId: MemberId, localDate: string) => `${type}:${memberId}:${localDate}`;

export type ClaimResult =
  | { claimed: true; claimId: string }
  | { claimed: false; reason: "already_sent" | "in_progress" };

const live = (r: NotificationLogRecord, now: Date) => r.status === "claimed" && now.getTime() - Date.parse(r.claimedAt) < CLAIM_LEASE_MS;

/**
 * Claims the right to send `type` to `memberId` for `localDate`, exactly once across retries, repeated cron
 * calls and concurrent server instances.
 *
 * Google Sheets has no transactions, so this is an optimistic claim: append a claim row, re-read, and the
 * claim that sits on the EARLIEST sheet row wins (appends are atomic and ordered). Losers mark their row
 * "failed" and back off. A "sent" row ends all attempts for that key; "failed" rows and expired claims
 * (a run that crashed) do not block a retry.
 */
export async function claimSlot(type: NotificationType, memberId: MemberId, localDate: string, now: Date = new Date()): Promise<ClaimResult> {
  const logKey = logKeyFor(type, memberId, localDate);
  const claimId = `clm_${randomUUID()}`;
  const stamp = nowIso(now);

  const first = await withWriteLock(async (): Promise<ClaimResult | null> => {
    const rows = (await readNotificationLogLocated({ fresh: true })).items.map((i) => i.value).filter((r) => r.logKey === logKey);
    if (rows.some((r) => r.status === "sent")) return { claimed: false, reason: "already_sent" };
    if (rows.some((r) => live(r, now))) return { claimed: false, reason: "in_progress" };
    await appendNotificationLog({ logKey, claimId, memberId, type, localDate, status: "claimed", claimedAt: stamp, updatedAt: stamp, detail: "" });
    return null;
  });
  if (first) return first;

  // Verify: did another instance append a competing claim at the same time?
  const after = (await readNotificationLogLocated({ fresh: true })).items.filter((i) => i.value.logKey === logKey);
  if (after.some((i) => i.value.status === "sent")) {
    await finishSlot(claimId, "failed", "superseded", now);
    return { claimed: false, reason: "already_sent" };
  }
  const winner = after.filter((i) => live(i.value, now)).sort((a, b) => a.row - b.row)[0];
  if (winner?.value.claimId === claimId) return { claimed: true, claimId };
  await finishSlot(claimId, "failed", "superseded", now);
  return { claimed: false, reason: "in_progress" };
}

/** Records the outcome of a claim ("sent" is final; "failed" allows a retry). Located by ClaimID, never by row number. */
export async function finishSlot(claimId: string, status: Exclude<NotificationStatus, "claimed">, detail: string, now: Date = new Date()): Promise<void> {
  await withWriteLock(async () => {
    const hit = (await readNotificationLogLocated({ fresh: true })).items.find((i) => i.value.claimId === claimId);
    if (!hit) return;
    await updateNotificationLogRow(hit.row, { ...hit.value, status, detail: detail.slice(0, 100), updatedAt: nowIso(now) });
  });
}

/** Deletes ledger rows older than LOG_KEEP_DAYS. Only touches this tab. */
export async function pruneLog(todayKey: string): Promise<number> {
  const cutoff = addDays(todayKey, -LOG_KEEP_DAYS);
  return withWriteLock(async () => {
    const { items } = await readNotificationLogLocated({ fresh: true });
    const rows = items.filter((i) => i.value.localDate < cutoff).map((i) => i.row);
    if (rows.length > 0) await deleteTabRows("notificationLog", rows);
    return rows.length;
  });
}
