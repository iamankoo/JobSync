import "server-only";
import webpush from "web-push";
import { after } from "next/server";
import type { MemberId } from "@/config/members";
import type { PushSubscriptionRecord } from "@/types/domain";
import { listSubscriptionsFor, removeSubscriptionsById } from "@/lib/google-sheets/push-service";
import { loadVapidConfig } from "./config";
import { callStartedPayload, jobAddedPayload, jobAppliedPayload, recipientsFor, type PushPayload } from "./payload";

/** Outcome of one delivery attempt to one subscription. `gone` = the push service says it no longer exists. */
export type SendResult = { ok: true } | { ok: false; gone: boolean; status?: number };
export type PushSender = (sub: PushSubscriptionRecord, payload: PushPayload) => Promise<SendResult>;

const SEND_TIMEOUT_MS = 6_000;
const TTL_SECONDS = 24 * 3600;

/** Real delivery through the Web Push protocol with VAPID. */
const webPushSender: PushSender = async (sub, payload) => {
  const vapid = loadVapidConfig();
  if (!vapid) return { ok: false, gone: false };
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: TTL_SECONDS, urgency: "high", timeout: SEND_TIMEOUT_MS, vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey } },
    );
    return { ok: true };
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    return { ok: false, gone: status === 404 || status === 410, status };
  }
};

let sender: PushSender = webPushSender;
/** Test hook: replace (or restore with null) the delivery function. */
export function setPushSenderForTesting(fn: PushSender | null): void {
  sender = fn ?? webPushSender;
}

// ---- idempotency --------------------------------------------------------
// Each notification has an event key. A key already handled by this instance is skipped, so a retried or
// repeated request cannot notify twice. (Retries of the underlying action are also rejected earlier:
// a duplicate job URL is refused and an unchanged status reports changed=false.) The notification `tag`
// additionally collapses duplicates on the device across server instances.
const DEDUPE_TTL_MS = 10 * 60_000;
const g = globalThis as unknown as { __jobsyncPushSeen?: Map<string, number> };
const seen = (): Map<string, number> => (g.__jobsyncPushSeen ??= new Map());

function claim(eventKey: string, now = Date.now()): boolean {
  const map = seen();
  for (const [k, at] of map) if (now - at > DEDUPE_TTL_MS) map.delete(k);
  if (map.has(eventKey)) return false;
  map.set(eventKey, now);
  return true;
}

export function resetPushDedupeForTesting(): void {
  seen().clear();
}

export interface NotifyOutcome {
  attempted: number;
  delivered: number;
  removed: number;
  /** Subscriptions that failed for a reason other than "gone" (kept; may work next time). */
  failed: number;
}

/** Sends to each subscription, removes the ones the push service reports as gone, and tallies the result. Never throws. */
async function deliver(subs: PushSubscriptionRecord[], payload: PushPayload): Promise<NotifyOutcome> {
  const outcome: NotifyOutcome = { attempted: subs.length, delivered: 0, removed: 0, failed: 0 };
  const results = await Promise.all(subs.map((s) => sender(s, payload).catch((): SendResult => ({ ok: false, gone: false }))));
  const gone: string[] = [];
  results.forEach((r, i) => {
    if (r.ok) outcome.delivered += 1;
    else if (r.gone) gone.push(subs[i].subscriptionId);
    else outcome.failed += 1;
  });
  if (gone.length > 0) {
    await removeSubscriptionsById(gone).catch(() => undefined);
    outcome.removed = gone.length;
  }
  if (outcome.failed > 0 || gone.length > 0) console.warn(`[push] delivered ${outcome.delivered}/${outcome.attempted}, expired ${gone.length}, failed ${outcome.failed}`);
  return outcome;
}

/**
 * Sends `payload` to every device of the two members other than `actor`. Never throws: any failure
 * is logged by name/status only (no endpoints, keys or payloads) so the saved job/application is unaffected.
 */
export async function notifyOthers(actor: MemberId, payload: PushPayload, eventKey: string): Promise<NotifyOutcome> {
  const none: NotifyOutcome = { attempted: 0, delivered: 0, removed: 0, failed: 0 };
  try {
    if (!loadVapidConfig()) return none;
    if (!claim(eventKey)) return none;
    try {
      // Defence in depth: whatever the store returned, the actor is never a recipient.
      const all = (await listSubscriptionsFor(recipientsFor(actor))).filter((s) => s.memberId !== actor);
      // One browser can be registered for two recipients: it still gets this (identical) message once.
      const subs = [...new Map(all.map((s) => [s.endpoint, s])).values()];
      const outcome = await deliver(subs, payload);
      const perMember = Object.fromEntries(recipientsFor(actor).map((m) => [m, all.filter((s) => s.memberId === m).length]));
      console.info(`[push] ${eventKey.split(":")[0]} by ${actor}: devices per recipient ${JSON.stringify(perMember)}, delivered ${outcome.delivered}/${outcome.attempted}`);
      return outcome;
    } catch (err) {
      // The subscription list could not be read: nothing was sent, so let a retry of this event try again.
      seen().delete(eventKey);
      throw err;
    }
  } catch (err) {
    console.error("[push] notification failed", err instanceof Error ? err.name : typeof err);
    return none;
  }
}

/**
 * Sends a PRIVATE notification to one member's devices only (scheduled messages). Idempotency is the caller's
 * job (the NotificationLog ledger). Throws only when the subscription list cannot be read, so the caller can retry.
 */
export async function notifyMember(memberId: MemberId, payload: PushPayload): Promise<NotifyOutcome> {
  if (!loadVapidConfig()) return { attempted: 0, delivered: 0, removed: 0, failed: 0 };
  const subs = (await listSubscriptionsFor([memberId])).filter((s) => s.memberId === memberId);
  return deliver(subs, payload);
}

/**
 * Runs `task` after the HTTP response is sent (so saving never waits on push services). Outside a
 * request (tests, scripts) `after` is unavailable and the task is awaited instead.
 */
async function afterResponse(task: () => Promise<unknown>): Promise<void> {
  try {
    after(task);
  } catch {
    await task();
  }
}

interface JobFacts {
  jobId: string;
  company: string;
  jobRole: string;
}

/** Call ONLY after the job row is persisted. */
export function notifyJobAdded(actor: MemberId, job: JobFacts): Promise<void> {
  return afterResponse(() => notifyOthers(actor, jobAddedPayload(actor, job), `job-added:${job.jobId}`));
}

/** Call ONLY after the Not Applied -> Applied change is persisted. `appliedAt` identifies this apply cycle. */
export function notifyJobApplied(actor: MemberId, job: JobFacts, appliedAt: string): Promise<void> {
  return afterResponse(() => notifyOthers(actor, jobAppliedPayload(actor, job), `job-applied:${job.jobId}:${actor}:${appliedAt}`));
}

/** Tells the other two members that `actor` started a call, so they can join. Never throws. */
export function notifyCallStarted(actor: MemberId, callId: string, media: "audio" | "video"): Promise<void> {
  return afterResponse(() => notifyOthers(actor, callStartedPayload(actor, callId, media), `call:${callId}`));
}
