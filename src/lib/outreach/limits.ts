/**
 * Sending limits. Conservative defaults, configurable only within hard ceilings, so no configuration (including a typo or a
 * huge number) can produce unlimited sending. These limits are independent of the 200/day IMPORT limit and of the drafting
 * limit: importing and drafting are cheap and reversible, sending is not.
 */
import { MEMBER_IDS, type MemberId } from "@/config/members";
import type { SendRecord } from "./types";

export interface SendLimits {
  perMemberDaily: number;
  globalDaily: number;
  /** Maximum messages one cron execution may send. */
  perRun: number;
}

export const DEFAULT_SEND_LIMITS: SendLimits = { perMemberDaily: 200, globalDaily: 600, perRun: 10 };
/** Absolute ceilings: values above these are ignored (the default applies). Well below Gmail's own daily sending quota. */
export const MAX_SEND_LIMITS: SendLimits = { perMemberDaily: 200, globalDaily: 600, perRun: 30 };

const pick = (raw: string | undefined, fallback: number, max: number) => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  // 0 is allowed (pauses sending); anything non-integer, negative or above the ceiling falls back to the default.
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
};

export function loadSendLimits(env: NodeJS.ProcessEnv = process.env): SendLimits {
  const limits = {
    perMemberDaily: pick(env.OUTREACH_SEND_PER_MEMBER_DAILY, DEFAULT_SEND_LIMITS.perMemberDaily, MAX_SEND_LIMITS.perMemberDaily),
    globalDaily: pick(env.OUTREACH_SEND_GLOBAL_DAILY, DEFAULT_SEND_LIMITS.globalDaily, MAX_SEND_LIMITS.globalDaily),
    perRun: pick(env.OUTREACH_SEND_PER_RUN, DEFAULT_SEND_LIMITS.perRun, MAX_SEND_LIMITS.perRun),
  };
  // The global limit can never exceed what the per-member limits allow in total.
  return { ...limits, globalDaily: Math.min(limits.globalDaily, limits.perMemberDaily * MEMBER_IDS.length) };
}

/** A claim that never reached "sending" is stale after this long (no API call was made, so it is safe to release). */
export const CLAIM_TTL_MS = 10 * 60_000;

/** The sending limits are measured over a rolling window, never a calendar day. */
export const SEND_WINDOW_MS = 24 * 60 * 60_000;

/** When a ledger row counts from: the confirmed send time, otherwise when it was claimed. */
const stampOf = (r: SendRecord) => Date.parse(r.sentAt || r.createdAt);

/** Does this ledger row use up sending allowance right now? Sent, being sent, or uncertain (it might have gone out), or a fresh claim. */
export const countsAgainstLimit = (r: SendRecord, nowMs: number) =>
  nowMs - stampOf(r) < SEND_WINDOW_MS && (r.status === "sent" || r.status === "sending" || r.status === "uncertain" || (r.status === "claimed" && nowMs - Date.parse(r.updatedAt || r.createdAt) < CLAIM_TTL_MS));

/**
 * Usage over the LAST 24 HOURS, per sending member and combined, counted conservatively (a message that is claimed, being sent or
 * of uncertain outcome counts as well as every confirmed send). Failed, released and superseded rows never count (nothing was sent).
 */
export function usageRolling(ledger: readonly SendRecord[], nowMs: number): { global: number; byMember: Record<MemberId, number> } {
  const byMember = { anni: 0, lukky: 0, rishii: 0 } as Record<MemberId, number>;
  let global = 0;
  for (const r of ledger) {
    if (!countsAgainstLimit(r, nowMs)) continue;
    global += 1;
    if (r.member in byMember) byMember[r.member as MemberId] += 1;
  }
  return { global, byMember };
}

/** `usage` is recomputed from the ledger before every candidate, so it already includes this run's sends; only the per-run cap needs `sentThisRun`. */
export function limitReason(limits: SendLimits, usage: ReturnType<typeof usageRolling>, member: MemberId, sentThisRun: number): string | null {
  if (sentThisRun >= limits.perRun) return `per-run sending limit (${limits.perRun}) reached`;
  if (usage.global >= limits.globalDaily) return `global rolling 24-hour sending limit (${limits.globalDaily}) reached`;
  if (usage.byMember[member] >= limits.perMemberDaily) return `${member}'s rolling 24-hour sending limit (${limits.perMemberDaily}) reached`;
  return null;
}
