/**
 * Posting-age windows for the daily job search, newest first. Age is counted in CALENDAR DAYS in the app's time zone
 * between the job's ORIGINAL posting date and today (never the date JobSync found or saved it):
 *
 *   window 1: 0–7   2: 8–15   3: 16–30   4: 31–60   5: 61–90   6: 91–120   (older than 120 days: rejected)
 *
 * The windows do not overlap, so a job belongs to exactly one. A missing, unparseable or implausible date (more than a day in
 * the future) is "undated": it is never treated as new and is not placed in any window. Pure (no I/O).
 */
export interface RecencyWindow {
  n: number;
  from: number;
  to: number;
}

export const RECENCY_WINDOWS: readonly RecencyWindow[] = [
  { n: 1, from: 0, to: 7 },
  { n: 2, from: 8, to: 15 },
  { n: 3, from: 16, to: 30 },
  { n: 4, from: 31, to: 60 },
  { n: 5, from: 61, to: 90 },
  { n: 6, from: 91, to: 120 },
];
export const MAX_AGE_DAYS = 120;
export const LAST_WINDOW = RECENCY_WINDOWS.length;

export type PostingAge = { status: "dated"; days: number; window: number } | { status: "too_old"; days: number } | { status: "undated"; reason: string };

const ymd = (ms: number, timeZone: string): number => {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

export function windowForAge(days: number): number | null {
  return RECENCY_WINDOWS.find((w) => days >= w.from && days <= w.to)?.n ?? null;
}

export function postingAge(postedAt: string | undefined, nowMs: number, timeZone: string): PostingAge {
  if (!postedAt?.trim()) return { status: "undated", reason: "posting date not given" };
  const t = Date.parse(postedAt);
  if (!Number.isFinite(t)) return { status: "undated", reason: "posting date unreadable" };
  let days = Math.round((ymd(nowMs, timeZone) - ymd(t, timeZone)) / 86_400_000);
  if (days < 0) {
    if (days < -1) return { status: "undated", reason: "posting date is in the future" };
    days = 0; // a time-zone edge of the same day
  }
  if (days > MAX_AGE_DAYS) return { status: "too_old", days };
  return { status: "dated", days, window: windowForAge(days)! };
}
