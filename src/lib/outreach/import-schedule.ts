/**
 * WHEN the Outreach Database import may run, and how many contacts it may take now (the owner's schedule, 14 Nov 2026):
 *  - nothing is imported before `importsFrom` (a pause while the existing Connections are drafted and sent for all three members);
 *  - each day's allowance opens at `dayStart` local time (default 00:15) and holds `dailyLimit` contacts (200) until the next day's start;
 *  - contacts come in BATCHES (default 50): a batch is imported, then the next one only once every Connection of the batches already imported
 *    in this day's window is finished for all three members (sent, or stopped for review / blocked / failed), so each batch is drafted and sent
 *    before the next arrives. A Connection that is still unfinished BATCH_MAX_WAIT_MS after it was claimed no longer holds the queue.
 * Only the import is scheduled; drafting and sending of Connections already in JobSync (manual ones first) always continue.
 */
import type { TrackingRecord } from "./types";

export const DEFAULT_DAY_START = "00:15";
export const DEFAULT_BATCH_SIZE = 50;
export const BATCH_MAX_WAIT_MS = 8 * 60 * 60_000;

export interface ImportScheduleConfig {
  /** ISO time before which nothing is imported ("" = no pause). */
  importsFrom: string;
  /** "HH:MM" local time at which each day's allowance opens. */
  dayStart: string;
  batchSize: number;
  dailyLimit: number;
}

export type ImportDecision =
  | { allowed: false; reason: string; windowStart: string; importedInWindow: number }
  | { allowed: true; take: number; windowStart: string; importedInWindow: number; batch: number };

/** Offset of `timeZone` from UTC at `at`, in ms (positive east of Greenwich). */
function offsetMs(at: Date, timeZone: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The most recent `dayStart` (local time in `timeZone`) at or before `now`. */
export function windowStartOf(now: Date, timeZone: string, dayStart: string): Date {
  const [h, m] = (/^(\d{1,2}):(\d{2})$/.exec(dayStart) ?? [, "0", "15"]).slice(1).map(Number);
  const off = offsetMs(now, timeZone);
  const local = new Date(now.getTime() + off);
  let start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, m) - off;
  if (start > now.getTime()) start -= 24 * 60 * 60_000;
  return new Date(start);
}

const counts = (r: TrackingRecord) => r.source === "outreach-database" && (r.importStatus === "added" || r.importStatus === "importing") && r.lastError !== "linked-existing";

/** Finished for all three members as far as the import schedule is concerned. */
export function batchItemDone(r: TrackingRecord, nowMs: number): boolean {
  if (r.importStatus === "import_failed" || r.lastError === "linked-existing") return true;
  if (r.processing === "sent" || r.processing === "needs_review" || r.processing === "failed") return true;
  if (r.sendStatus === "sent" || r.sendStatus === "review" || r.sendStatus === "blocked" || r.sendStatus === "uncertain") return true;
  return nowMs - Date.parse(r.claimedAt) >= BATCH_MAX_WAIT_MS;
}

export function decideImport(records: readonly TrackingRecord[], now: Date, timeZone: string, cfg: ImportScheduleConfig): ImportDecision {
  const ws = windowStartOf(now, timeZone, cfg.dayStart);
  const inWindow = records.filter((r) => counts(r) && Date.parse(r.claimedAt) >= ws.getTime());
  const base = { windowStart: ws.toISOString(), importedInWindow: inWindow.length };
  if (cfg.importsFrom && now.getTime() < Date.parse(cfg.importsFrom)) return { allowed: false, reason: `imports paused until ${cfg.importsFrom}`, ...base };
  const left = cfg.dailyLimit - inWindow.length;
  if (left <= 0) return { allowed: false, reason: `today's ${cfg.dailyLimit} imports are done; the next allowance opens at ${cfg.dayStart}`, ...base };
  const size = Math.max(1, cfg.batchSize);
  const filled = inWindow.length % size;
  const batch = Math.floor(inWindow.length / size) + 1;
  // The current batch is still being filled: finish it.
  if (filled > 0) return { allowed: true, take: Math.min(size - filled, left), batch, ...base };
  // A batch is complete: the next one waits until every Connection imported in this window is finished.
  const open = inWindow.filter((r) => !batchItemDone(r, now.getTime())).length;
  if (open > 0) return { allowed: false, reason: `batch ${batch - 1}: ${open} Connections are still being drafted / sent; the next ${size} follow when they are done`, ...base };
  return { allowed: true, take: Math.min(size, left), batch, ...base };
}
