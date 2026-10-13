import { createHash } from "node:crypto";
import { getMember, type MemberId } from "@/config/members";
import { addDays, diffDays } from "@/lib/analytics/dates";
import { dateInTimezone } from "@/lib/utils/time";
import type { Job, NotificationType } from "@/types/domain";
import type { PushPayload } from "./payload";
import { QUOTES } from "./quotes";

export const DAILY_TARGET = 10;

/** Local clock windows (minutes after local midnight) in which each slot may be sent. A scheduler that fires a little late still works; one that fires early or on the wrong side of midnight is refused. */
export const SLOT_WINDOWS: Record<NotificationType, { from: number; to: number }> = {
  morning: { from: 10 * 60, to: 11 * 60 + 59 },
  night: { from: 22 * 60, to: 23 * 60 + 59 },
};

/** Minutes since local midnight of an instant in the given IANA timezone. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return get("hour") * 60 + get("minute");
}

export function inSlotWindow(type: NotificationType, now: Date, timeZone: string): boolean {
  const m = localMinutes(now, timeZone);
  const w = SLOT_WINDOWS[type];
  return m >= w.from && m <= w.to;
}

// ---- morning ------------------------------------------------------------

const hashInt = (text: string): number => createHash("sha256").update(text).digest().readUInt32BE(0);

const EPOCH = "2026-01-01";

/**
 * Index of the quote for a member on a local date. A pseudo-random walk over the list: each day moves forward by a
 * hash-derived step of 1..(n-1), so the pick looks random, differs between members, can never equal the previous
 * day's pick, and is identical on every retry (derived from member + date only, no stored state).
 */
export function quoteIndexFor(memberId: MemberId, dateKey: string): number {
  const n = QUOTES.length;
  const days = Math.max(0, diffDays(dateKey, EPOCH));
  let index = hashInt(`start|${memberId}`) % n;
  for (let d = 1; d <= days; d++) index = (index + 1 + (hashInt(`step|${memberId}|${addDays(EPOCH, d)}`) % (n - 1))) % n;
  return index;
}

export const quoteFor = (memberId: MemberId, dateKey: string): string => QUOTES[quoteIndexFor(memberId, dateKey)];

export function morningPayload(memberId: MemberId, dateKey: string): PushPayload {
  const name = getMember(memberId)?.name ?? "there";
  return {
    title: `Good morning, ${name}! ☀️`,
    body: `${quoteFor(memberId, dateKey)} Let's start applying and posting jobs!`,
    url: "/add-job",
    tag: `daily-morning-${dateKey}`,
  };
}

// ---- night --------------------------------------------------------------

/** Jobs `memberId` added on local calendar day `dateKey`. Counts only valid Jobs rows added by that member; each JobID once. */
export function countJobsAddedOn(jobs: readonly Job[], memberId: MemberId, dateKey: string, timeZone: string): number {
  const seen = new Set<string>();
  for (const job of jobs) {
    if (job.addedBy !== memberId || seen.has(job.jobId)) continue;
    const at = Date.parse(job.addedAt);
    if (Number.isNaN(at)) continue;
    if (dateInTimezone(new Date(at), timeZone) === dateKey) seen.add(job.jobId);
  }
  return seen.size;
}

/** The exact, mutually exclusive thresholds: 0-3, 4-6, 7-9, 10+. */
export function nightMessage(count: number, name: string): string {
  if (count <= 3) return `Need more efforts, ${name}.`;
  if (count <= 6) return `Good but still we can do better, ${name}.`;
  if (count <= 9) return `Nice going, let's finish the target, ${name}.`;
  return `Today's target achieved! Good night, ${name}.`;
}

export function nightPayload(memberId: MemberId, dateKey: string, count: number): PushPayload {
  const name = getMember(memberId)?.name ?? "there";
  return {
    title: `Hello, ${name}! 🌙`,
    body: `You added ${count} out of ${DAILY_TARGET} jobs today. ${nightMessage(count, name)}`,
    url: "/dashboard",
    tag: `daily-night-${dateKey}`,
  };
}
