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

export const DEFAULT_SEND_LIMITS: SendLimits = { perMemberDaily: 10, globalDaily: 25, perRun: 3 };
/** Absolute ceilings: values above these are ignored (the default applies). Well below Gmail's own daily sending quota. */
export const MAX_SEND_LIMITS: SendLimits = { perMemberDaily: 50, globalDaily: 100, perRun: 10 };

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

/**
 * Today's usage, counted CONSERVATIVELY. Every ledger row carries its IST accounting day (SentDay) from the moment it is claimed,
 * so a message that is claimed, being sent, or whose outcome is uncertain counts toward the limit (it might have gone out) as well as
 * every confirmed send. Failed, released and superseded rows never count (nothing was sent).
 */
export function usageToday(ledger: readonly SendRecord[], day: string, nowMs: number): { global: number; byMember: Record<MemberId, number> } {
  const byMember = { anni: 0, lukky: 0, rishii: 0 } as Record<MemberId, number>;
  let global = 0;
  for (const r of ledger) {
    if (r.sentDay !== day) continue;
    const counts = r.status === "sent" || r.status === "sending" || r.status === "uncertain" || (r.status === "claimed" && nowMs - Date.parse(r.updatedAt || r.createdAt) < CLAIM_TTL_MS);
    if (!counts) continue;
    global += 1;
    if (r.member in byMember) byMember[r.member as MemberId] += 1;
  }
  return { global, byMember };
}

/** `usage` is recomputed from the ledger before every candidate, so it already includes this run's sends; only the per-run cap needs `sentThisRun`. */
export function limitReason(limits: SendLimits, usage: ReturnType<typeof usageToday>, member: MemberId, sentThisRun: number): string | null {
  if (sentThisRun >= limits.perRun) return `per-run sending limit (${limits.perRun}) reached`;
  if (usage.global >= limits.globalDaily) return `global daily sending limit (${limits.globalDaily}) reached`;
  if (usage.byMember[member] >= limits.perMemberDaily) return `${member}'s daily sending limit (${limits.perMemberDaily}) reached`;
  return null;
}
