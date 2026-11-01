import { MEMBER_IDS, type MemberId } from "@/config/members";
import { discoveredJobPayload, recipientsFor, type PushPayload } from "@/lib/push/payload";
import type { BatchLedger } from "./scheduler";

/**
 * Notifications for jobs the daily search saved. Until 1 Nov 2026 these were silent (`notify: false`, meant for a batch summary that
 * no longer exists). A manual add notifies the other two members right after the row is saved; a discovered job does the same, with
 * wording that does not claim the member added it ("found for Aniket").
 *
 * Delivery is a small durable queue in NF_State (one note, `job-alerts`), so that:
 *  - a job is queued only AFTER its row was saved (never for a rejected listing, a duplicate or a failed write);
 *  - each of the two recipients is tracked separately and removed from the job the moment their delivery succeeded, so a cron retry,
 *    a restart or a crash between the two sends cannot notify anyone twice;
 *  - a failed delivery (push service down, subscription list unreadable, push not configured) stays queued and is retried on the
 *    next cron calls, up to MAX_ATTEMPTS, and only for the recipient who has not been notified yet;
 *  - a recipient with no registered device counts as handled (there is nothing to deliver to).
 * The note holds only ids, names of the company/role and the job type (already visible to every member) — no endpoints or keys.
 */
const KEY = "job-alerts";
export const MAX_ATTEMPTS = 6;
/** Alerts handled per flush, so a backlog cannot eat a whole cron call. */
const PER_FLUSH = 8;

export interface JobAlert {
  jobId: string;
  /** The member the job was saved under (credited as "found for"). */
  creator: MemberId;
  company: string;
  role: string;
  jobType: string;
  workMode?: string;
  /** Recipients still to notify. */
  to: MemberId[];
  attempts: number;
}

/** What the push layer reports for one member's devices (see push/notify.ts `NotifyOutcome`). */
export interface DeliveryOutcome {
  attempted: number;
  delivered: number;
  removed: number;
  failed: number;
}
export type AlertSender = (member: MemberId, payload: PushPayload) => Promise<DeliveryOutcome>;

async function load(ledger: BatchLedger): Promise<JobAlert[]> {
  try {
    const raw = JSON.parse((await ledger.getNote?.(KEY)) || "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((a): a is JobAlert => Boolean(a && typeof a.jobId === "string" && Array.isArray(a.to) && (a.to as unknown[]).every((m) => (MEMBER_IDS as readonly string[]).includes(String(m)))));
  } catch {
    return [];
  }
}

const store = (ledger: BatchLedger, list: JobAlert[]) => ledger.setNote?.(KEY, JSON.stringify(list)) ?? Promise.resolve();

/** Queues the two notifications for a job whose row has just been saved. Queuing the same job twice is a no-op. */
export async function queueJobAlert(ledger: BatchLedger, job: Omit<JobAlert, "to" | "attempts">): Promise<void> {
  if (!ledger.setNote) return;
  const list = await load(ledger);
  if (list.some((a) => a.jobId === job.jobId)) return;
  await store(ledger, [...list, { ...job, to: recipientsFor(job.creator), attempts: 0 }]);
}

export interface FlushResult {
  /** Notifications delivered (or handled because the member has no device) in this flush. */
  handled: number;
  /** Alerts still waiting for a retry. */
  pending: number;
  /** Alerts given up on after MAX_ATTEMPTS. */
  dropped: number;
}

/** Delivers queued alerts; each recipient is removed from the alert as soon as their delivery succeeded. Never throws. */
export async function flushJobAlerts(ledger: BatchLedger, send: AlertSender | undefined, hasTime: () => boolean = () => true): Promise<FlushResult> {
  const result: FlushResult = { handled: 0, pending: 0, dropped: 0 };
  if (!send || !ledger.getNote || !ledger.setNote) return result;
  let list = await load(ledger);
  let done = 0;
  for (const alert of [...list]) {
    if (done >= PER_FLUSH || !hasTime()) break;
    done += 1;
    const remaining: MemberId[] = [];
    for (const member of alert.to) {
      try {
        const o = await send(member, discoveredJobPayload(alert.creator, { jobId: alert.jobId, company: alert.company, jobRole: alert.role, jobType: alert.jobType, ...(alert.workMode ? { workMode: alert.workMode } : {}) }));
        // Delivered; or nothing to deliver to (no device / only expired devices). Only "every attempt failed" is retried.
        if (o.delivered > 0 || o.failed === 0) result.handled += 1;
        else remaining.push(member);
      } catch {
        remaining.push(member);
      }
    }
    const attempts = alert.attempts + (remaining.length ? 1 : 0);
    if (remaining.length === 0) list = list.filter((a) => a.jobId !== alert.jobId);
    else if (attempts >= MAX_ATTEMPTS) {
      list = list.filter((a) => a.jobId !== alert.jobId);
      result.dropped += 1;
    } else list = list.map((a) => (a.jobId === alert.jobId ? { ...a, to: remaining, attempts } : a));
    await store(ledger, list); // after every alert: a killed run keeps what it already delivered
  }
  result.pending = list.length;
  return result;
}
