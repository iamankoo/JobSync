import "server-only";
import { createHash } from "node:crypto";
import type { MemberId } from "@/config/members";
import type { PushSubscriptionRecord } from "@/types/domain";
import { nowIso } from "@/lib/utils/time";
import { DomainError } from "./errors";
import { withWriteLock } from "./lock";
import { appendPushSubscription, deleteTabRows, readPushSubscriptionsLocated, updatePushSubscriptionRow } from "./repositories";

/** Devices kept per member; the least recently seen are dropped beyond this. */
export const MAX_DEVICES_PER_MEMBER = 8;
/** LastSeenAt is refreshed at most this often so page loads do not turn into sheet writes. */
const TOUCH_AFTER_MS = 24 * 3_600_000;

/** Log-safe stable ID for an endpoint (the endpoint itself is a secret capability URL). */
export function subscriptionIdFor(endpoint: string): string {
  return `sub_${createHash("sha256").update(endpoint).digest("hex").slice(0, 32)}`;
}

export interface SubscribeInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Registers (or refreshes) a device subscription for `memberId` (from the session). Idempotent per endpoint.
 * An endpoint already registered with DIFFERENT keys is refused: only the browser that holds the keys can
 * legitimately re-register it, so this stops one member from taking over another member's subscription.
 * The same endpoint+keys under another member (a shared browser, new login) moves to the current member.
 */
export async function saveSubscription(memberId: MemberId, input: SubscribeInput, now: Date = new Date()): Promise<{ created: boolean }> {
  const subscriptionId = subscriptionIdFor(input.endpoint);
  return withWriteLock(async () => {
    const { items } = await readPushSubscriptionsLocated({ fresh: true });
    const existing = items.find((i) => i.value.subscriptionId === subscriptionId);
    const stamp = nowIso(now);

    if (existing) {
      const v = existing.value;
      if (v.p256dh !== input.keys.p256dh || v.auth !== input.keys.auth) {
        throw new DomainError("subscription_conflict", "This subscription cannot be registered.");
      }
      const stale = now.getTime() - Date.parse(v.lastSeenAt) > TOUCH_AFTER_MS;
      if (v.memberId !== memberId || stale) {
        await updatePushSubscriptionRow(existing.row, { ...v, memberId, lastSeenAt: stamp });
      }
      return { created: false };
    }

    // Keep each member's device list bounded.
    const mine = items.filter((i) => i.value.memberId === memberId).sort((a, b) => a.value.lastSeenAt.localeCompare(b.value.lastSeenAt));
    const excess = mine.length - (MAX_DEVICES_PER_MEMBER - 1);
    if (excess > 0) await deleteTabRows("pushSubscriptions", mine.slice(0, excess).map((i) => i.row));

    const record: PushSubscriptionRecord = {
      subscriptionId, memberId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, createdAt: stamp, lastSeenAt: stamp,
    };
    await appendPushSubscription(record);
    return { created: true };
  });
}

/** Removes the caller's own subscription for `endpoint`. Another member's row is never touched. */
export async function removeSubscription(memberId: MemberId, endpoint: string): Promise<{ removed: boolean }> {
  const subscriptionId = subscriptionIdFor(endpoint);
  return withWriteLock(async () => {
    const { items } = await readPushSubscriptionsLocated({ fresh: true });
    const row = items.find((i) => i.value.subscriptionId === subscriptionId && i.value.memberId === memberId);
    if (!row) return { removed: false };
    await deleteTabRows("pushSubscriptions", [row.row]);
    return { removed: true };
  });
}

/** Subscriptions of the given members (used for delivery). */
export async function listSubscriptionsFor(memberIds: readonly MemberId[]): Promise<PushSubscriptionRecord[]> {
  const { items } = await readPushSubscriptionsLocated();
  return items.map((i) => i.value).filter((s) => memberIds.includes(s.memberId));
}

/** Drops subscriptions the push service reported as gone. */
export async function removeSubscriptionsById(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await withWriteLock(async () => {
    const { items } = await readPushSubscriptionsLocated({ fresh: true });
    const rows = items.filter((i) => ids.includes(i.value.subscriptionId)).map((i) => i.row);
    if (rows.length > 0) await deleteTabRows("pushSubscriptions", rows);
  });
}
