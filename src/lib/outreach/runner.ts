/**
 * The long-running side of the outreach pipeline: ONE background runner (a Netlify Background Function, 15-minute limit) that executes the
 * existing outreach cycle repeatedly, instead of one cycle per short-lived HTTP request.
 *
 * What did NOT change: the cycle itself (runOutreachCycle: manual Connections, historical drafts, sending, import, drafting, notifications), its own
 * per-cycle run lock (65 s TTL), the write-ahead send claims, the send ledger and every safety check. Each iteration below is exactly the cycle the
 * cron used to run, with the same time budgets.
 *
 * What this adds:
 *  - a RUNNER lock (state key "bg-runner") so two background invocations never run side by side. It has a short TTL and a heartbeat: a live runner
 *    keeps renewing it, a killed one stops renewing and the lock simply expires, so the next cron call takes over;
 *  - cycles start at the old cadence (default every 2 minutes, like the cron did), so Sheets/Gmail quotas see the same load as before;
 *  - the runner stops well before the platform limit (12 minutes + the last cycle) and the next cron call starts a fresh one;
 *  - a cycle that hit its hard stop is never overlapped: the runner waits for it to settle and otherwise stops without releasing its lock.
 * Nothing here relies on Next.js `after()`.
 */
import { loadOutreachConfig } from "./config";
import { runOutreachInBackground, type BackgroundOutcome } from "./background";
import { openOutreachSheet } from "./run";
import { RUNNER_LOCK_KEY, type OutreachSheet } from "./sheet";

/** A killed runner frees the runner lock after this long; it must outlast one cycle (55 s hard stop + settle grace) plus a missed heartbeat. */
export const RUNNER_LOCK_TTL_MS = 200_000;
export const RUNNER_HEARTBEAT_MS = 40_000;
/** The runner starts no new cycle after this; the one in flight finishes (<= HARD_STOP + SETTLE_GRACE), staying under the 15-minute function limit. */
export const RUNNER_MAX_RUN_MS = 11 * 60_000;
/** Cycles start at least this far apart (the old cron cadence). Override with OUTREACH_CYCLE_INTERVAL_S (60-600). */
export const DEFAULT_CYCLE_INTERVAL_MS = 120_000;
export const MIN_CYCLE_GAP_MS = 10_000;
/** How long the runner waits for a cycle that passed its hard stop to finish on its own before giving up on the whole run. */
export const SETTLE_GRACE_MS = 30_000;
export const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * Send-first cycles in a row that send nothing before the runner stops using send-first mode for the rest of its run (normal work resumes). It prevents a
 * backlog that cannot be sent (every remaining draft blocked by a content or résumé check) from keeping imports and drafting off forever.
 */
export const SEND_FIRST_IDLE_LIMIT = 2;

export interface RunnerLock {
  acquire(): Promise<boolean>;
  /** false = the lock is no longer ours. A thrown error is a transient failure (the next heartbeat tries again). */
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export interface RunnerDeps {
  lock: RunnerLock;
  /** One outreach cycle (the existing time-boxed wrapper). Never expected to throw. `noSendFirst`: run it in normal mode. */
  runCycle: (opts: { noSendFirst: boolean }) => Promise<BackgroundOutcome>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  intervalMs?: number;
  maxRunMs?: number;
  heartbeatMs?: number;
  settleGraceMs?: number;
  /** Schedules the lock heartbeat; returns its stop function. Defaults to setInterval (tests drive it from a virtual clock). */
  heartbeat?: (tick: () => void, everyMs: number) => () => void;
}

export type RunnerStop = "busy" | "disabled" | "time-limit" | "lock-lost" | "stuck-cycle" | "repeated-errors" | "error";
export interface RunnerResult {
  status: RunnerStop;
  cycles: number;
  completed: number;
  /** Cycles that ran in send-first mode, and whether the runner gave up on that mode because it stopped making progress. */
  sendFirstCycles: number;
  sendFirstSuspended: boolean;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Never throws. Counts and statuses only are logged. */
export async function runOutreachRunner(deps: RunnerDeps): Promise<RunnerResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const log = deps.log ?? ((line: string) => console.log(line));
  const intervalMs = deps.intervalMs ?? DEFAULT_CYCLE_INTERVAL_MS;
  const maxRunMs = deps.maxRunMs ?? RUNNER_MAX_RUN_MS;
  const settleGraceMs = deps.settleGraceMs ?? SETTLE_GRACE_MS;
  const started = now();
  const out: RunnerResult = { status: "time-limit", cycles: 0, completed: 0, sendFirstCycles: 0, sendFirstSuspended: false };
  const finish = (status: RunnerStop) => {
    out.status = status;
    log(`[outreach-runner] ${JSON.stringify({ status, cycles: out.cycles, completed: out.completed, sendFirst: out.sendFirstCycles, sendFirstSuspended: out.sendFirstSuspended, ms: now() - started })}`);
    return out;
  };

  let stopBeat: (() => void) | undefined;
  let holding = false;
  let release = true; // false when a cycle may still be running: the lock must then expire by itself, never be handed to a second runner
  try {
    if (!(await deps.lock.acquire())) return finish("busy");
    holding = true;
    let lost = false;
    let lastBeat = now();
    const startBeat = deps.heartbeat ?? ((tick: () => void, everyMs: number) => { const h = setInterval(tick, everyMs); return () => clearInterval(h); });
    stopBeat = startBeat(() => {
      deps.lock.renew().then(
        (ok) => {
          if (ok) lastBeat = now();
          else lost = true;
        },
        () => undefined, // transient (e.g. Sheets 429): the next beat retries; staleness is checked below
      );
    }, deps.heartbeatMs ?? RUNNER_HEARTBEAT_MS);

    let failures = 0;
    let idleSendFirst = 0;
    for (;;) {
      if (lost || now() - lastBeat >= RUNNER_LOCK_TTL_MS) return finish("lock-lost");
      if (now() - started >= maxRunMs) return finish("time-limit");
      const cycleStart = now();
      out.cycles += 1;
      const outcome = await deps.runCycle({ noSendFirst: out.sendFirstSuspended });
      if (outcome.status === "disabled") return finish("disabled");
      if (outcome.status === "timed-out") {
        const settled = outcome.settled ? await Promise.race([outcome.settled.then(() => true), sleep(settleGraceMs).then(() => false)]) : false;
        if (!settled) {
          release = false;
          return finish("stuck-cycle");
        }
      }
      if (outcome.status === "completed") out.completed += 1;
      if (outcome.mode === "send-first") {
        out.sendFirstCycles += 1;
        idleSendFirst = (outcome.sent ?? 0) > 0 ? 0 : idleSendFirst + 1;
        if (idleSendFirst >= SEND_FIRST_IDLE_LIMIT) out.sendFirstSuspended = true;
      }
      if (outcome.status === "error") {
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) return finish("repeated-errors");
      } else if (outcome.status !== "timed-out") {
        failures = 0;
      }
      // While draining a backlog, cycles follow each other with only a short pause; otherwise they keep the 2-minute cadence.
      const wait = outcome.mode === "send-first" ? MIN_CYCLE_GAP_MS : Math.max(MIN_CYCLE_GAP_MS, intervalMs - (now() - cycleStart));
      if (now() - started + wait >= maxRunMs) return finish("time-limit");
      await sleep(wait);
    }
  } catch (err) {
    log(`[outreach-runner] ${JSON.stringify({ status: "error", error: err instanceof Error ? err.name : "error" })}`);
    out.status = "error";
    return out;
  } finally {
    stopBeat?.();
    if (holding && release) await deps.lock.release().catch(() => undefined);
  }
}

/** The runner lock on the real Outreach Database state tab (a separate sheet instance from the cycles', so the two locks never mix). */
export function sheetRunnerLock(sheet: OutreachSheet, now: () => number = Date.now): RunnerLock {
  return {
    acquire: () => sheet.acquireLock(now(), RUNNER_LOCK_TTL_MS, RUNNER_LOCK_KEY),
    renew: () => sheet.renewLock(now(), RUNNER_LOCK_TTL_MS, RUNNER_LOCK_KEY),
    release: () => sheet.releaseLock(now(), RUNNER_LOCK_KEY),
  };
}

export function cycleIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const s = Number(env.OUTREACH_CYCLE_INTERVAL_S);
  return Number.isFinite(s) && s >= 60 && s <= 600 ? Math.floor(s) * 1000 : DEFAULT_CYCLE_INTERVAL_MS;
}

/** Production wiring for the background function. Returns null when outreach is switched off or not configured. */
export function buildRealRunnerDeps(env: NodeJS.ProcessEnv = process.env): RunnerDeps | null {
  const cfg = loadOutreachConfig(env);
  if (!cfg.enabled) return null;
  return {
    lock: sheetRunnerLock(openOutreachSheet(cfg)),
    runCycle: (o) => runOutreachInBackground({ noSendFirst: o.noSendFirst }),
    intervalMs: cycleIntervalMs(env),
  };
}
