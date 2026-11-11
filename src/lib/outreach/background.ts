/**
 * Runs ONE outreach cycle as background work of the cron request, within the platform's execution limit.
 *
 * Why this exists: the cycle needs 40-55 s (Google Sheets reads/writes, Gmail, back-off on 429s), but the external scheduler gives up after
 * 30 s. The route therefore answers 202 immediately and hands this function to Next.js `after()`, which Vercel runs with `waitUntil`: the
 * invocation stays alive for the route's `maxDuration` after the response has been sent. Nothing here relies on an un-awaited promise.
 *
 * Safety: the cycle is already built from small, idempotent, resumable steps (write-ahead claims, send ledger, run lock). If the platform
 * ever kills the invocation early, the lock expires on its own and the next cron call continues from the durable state; an interrupted send is
 * reconciled against Gmail, never retried blindly. This wrapper adds the time discipline: a retry deadline (so 429 back-off cannot burn the whole
 * budget), rate-limit pressure tracking (so drafting yields before sending/importing do) and a hard stop below the platform limit.
 */
import { resetSheetsRateLimitHits, setSheetsRetryDeadline, sheetsRateLimitHits } from "@/lib/google-sheets/client";
import { withHardDeadline } from "@/lib/network-finder/run";
import { loadOutreachConfig } from "./config";
import { buildRealCycleDeps, runOutreachCycle, summarizeCycle, type CycleDeps, type CycleResult } from "./run";

/** Vercel `maxDuration` of the cron route. The work must finish (and release its lock) well inside it. */
export const ROUTE_MAX_DURATION_S = 60;
/** The cycle plans its steps inside this budget (send ~20 s, import ~36 s, drafting ~44 s). */
export const CYCLE_BUDGET_MS = 44_000;
/** Sheets retry sleeping stops here, so a 429 storm cannot hold the run past the budget. */
export const RETRY_DEADLINE_MS = 50_000;
/** Absolute stop (the lock then expires by itself). */
export const HARD_STOP_MS = 55_000;

export interface BackgroundDeps {
  build?: (budgetMs: number) => CycleDeps;
  run?: (deps: CycleDeps) => Promise<CycleResult>;
  log?: (line: string) => void;
  now?: () => number;
  hardStopMs?: number;
}

export interface BackgroundOutcome {
  status: "completed" | "busy" | "disabled" | "timed-out" | "error";
  /**
   * Only for "timed-out": resolves when the abandoned cycle finally settles. The hard stop cannot cancel it, so a long-lived caller (the background
   * runner) must wait for this before starting another cycle; otherwise two cycles could overlap once the run lock has expired.
   */
  settled?: Promise<void>;
}

/** Never throws: it runs after the response, where an exception would only be lost. */
export async function runOutreachInBackground(d: BackgroundDeps = {}): Promise<BackgroundOutcome> {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((line: string) => console.log(line));
  const started = now();
  setSheetsRetryDeadline(started + RETRY_DEADLINE_MS);
  resetSheetsRateLimitHits();
  try {
    const cfg = loadOutreachConfig();
    if (!cfg.enabled) return { status: "disabled" };
    const deps = (d.build ?? ((budget: number) => buildRealCycleDeps(cfg, process.env, budget)))(CYCLE_BUDGET_MS);
    const cycle = (d.run ?? runOutreachCycle)(deps);
    const run = await withHardDeadline(cycle, d.hardStopMs ?? HARD_STOP_MS);
    if (run === "timed-out") {
      log(`[outreach] ${JSON.stringify({ status: "timed-out", rateLimited: sheetsRateLimitHits() })}`);
      return { status: "timed-out", settled: cycle.then(() => undefined, () => undefined) };
    }
    if (!run.ran) {
      log(`[outreach] ${JSON.stringify({ status: run.reason ?? "disabled" })}`);
      return { status: run.reason === "busy" ? "busy" : "disabled" };
    }
    const s = summarizeCycle(run);
    // Counts and statuses only: no names, e-mail addresses, companies, tokens or message text.
    log(`[outreach] ${JSON.stringify({ status: "completed", ms: now() - started, rateLimited: sheetsRateLimitHits(), gmail: s.gmail && { lapsed: s.gmail.lapsed, expiring: s.gmail.expiring, alerted: s.gmail.alerted }, existing: s.existing && { adopted: s.existing.adopted, remaining: s.existing.remaining, orphaned: s.existing.orphaned, parked: s.existing.parked }, import: s.import && { imported: s.import.importedThisRun, today: s.import.importedToday, stop: s.import.stoppedBecause, priorityLeft: s.import.priorityRemaining ?? 0 }, drafts: typeof s.drafts === "object" && s.drafts ? s.drafts : s.drafts, send: s.send && { status: s.send.status, sent: s.send.sent, outside: s.send.externallySent ?? 0, stale: s.send.staleSkipped ?? 0, review: s.send.needsReview, failed: s.send.failed, waiting: s.send.waiting, stop: s.send.stoppedBecause }, errors: s.errors.length })}`);
    return { status: "completed" };
  } catch (err) {
    log(`[outreach] ${JSON.stringify({ status: "error", error: err instanceof Error ? err.name : "error" })}`);
    return { status: "error" };
  } finally {
    setSheetsRetryDeadline(null);
  }
}
