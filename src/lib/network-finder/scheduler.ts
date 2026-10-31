import { dateInTimezone } from "@/lib/utils/time";

/**
 * Five daily discovery windows (local time in APP_TIMEZONE), 10 companies each = 50 a day. A scheduler
 * (cron-job.org or Vercel Cron) calls the batch endpoint repeatedly inside each window; every call does a
 * small, time-bounded slice of work, and the ledger stops the window once its 10 are done.
 */
export const BATCH_WINDOWS = [
  { start: 2, end: 4 },
  { start: 6, end: 8 },
  { start: 10, end: 12 },
  { start: 14, end: 16 },
  { start: 18, end: 20 },
] as const;
export const BATCH_SIZE = 10;
export const DAILY_TARGET = BATCH_WINDOWS.length * BATCH_SIZE;

/** Local hour as a fraction (14.5 = 14:30) in `timeZone`. */
export function localHour(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h + m / 60;
}

export interface ActiveWindow {
  /** 0–4 */
  index: number;
  /** Local date the window belongs to (YYYY-MM-DD). */
  date: string;
  /** Ledger key, e.g. "2026-10-27#2". */
  key: string;
}

/** The window `now` falls in, or null outside all five windows. */
export function activeWindow(now: Date, timeZone: string): ActiveWindow | null {
  const h = localHour(now, timeZone);
  const index = BATCH_WINDOWS.findIndex((w) => h >= w.start && h < w.end);
  if (index < 0) return null;
  const date = dateInTimezone(now, timeZone);
  return { index, date, key: `${date}#${index}` };
}

/** Counts completed work per key ("2026-10-27#2" for a batch window, "2026-10-27#jobs-internship" …). */
export interface BatchLedger {
  get(key: string): Promise<number>;
  add(key: string, n: number): Promise<number>;
  /** Small text records (the daily job-search funnel). Optional: a ledger without them simply keeps no funnel. */
  getNote?(key: string): Promise<string | undefined>;
  setNote?(key: string, value: string): Promise<void>;
}

export class InMemoryBatchLedger implements BatchLedger {
  private map = new Map<string, number>();
  private notes = new Map<string, string>();
  async getNote(key: string) {
    return this.notes.get(key);
  }
  async setNote(key: string, value: string) {
    this.notes.set(key, value);
  }
  async get(key: string) {
    return this.map.get(key) ?? 0;
  }
  async add(key: string, n: number) {
    const v = (this.map.get(key) ?? 0) + n;
    this.map.set(key, v);
    return v;
  }
}
