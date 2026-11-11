/**
 * The background RUNNER (src/lib/outreach/runner.ts): one long-lived invocation that executes outreach cycles one after another.
 * Time is virtual (a fake clock the runner's sleeps advance), so a 12-minute run takes milliseconds. No Google, Gmail or network calls.
 */
import { describe, expect, it, vi } from "vitest";
import type { BackgroundOutcome } from "@/lib/outreach/background";
import {
  DEFAULT_CYCLE_INTERVAL_MS, MAX_CONSECUTIVE_FAILURES, MIN_CYCLE_GAP_MS, RUNNER_HEARTBEAT_MS, RUNNER_LOCK_TTL_MS, RUNNER_MAX_RUN_MS, SETTLE_GRACE_MS,
  cycleIntervalMs, runOutreachRunner, type RunnerDeps,
} from "@/lib/outreach/runner";

/** A virtual clock; sleeping advances it and fires the lock heartbeat for every heartbeat period that passes, like the real timer would. */
function world(heartbeatMs = RUNNER_HEARTBEAT_MS) {
  let t = 0;
  let tick: (() => void) | null = null;
  let nextBeat = heartbeatMs;
  const sleeps: number[] = [];
  const advance = (ms: number) => {
    t += ms;
    while (tick && nextBeat <= t) {
      nextBeat += heartbeatMs;
      tick();
    }
  };
  return {
    now: () => t,
    advance,
    sleeps,
    sleep: async (ms: number) => { sleeps.push(ms); advance(ms); },
    heartbeat: (fn: () => void) => { tick = fn; nextBeat = t + heartbeatMs; return () => { tick = null; }; },
  };
}

const lockOf = (over: { acquire?: () => Promise<boolean>; renew?: () => Promise<boolean>; release?: () => Promise<void> } = {}) => ({
  acquire: vi.fn(over.acquire ?? (async () => true)),
  renew: vi.fn(over.renew ?? (async () => true)),
  release: vi.fn(over.release ?? (async () => undefined)),
});
const done = (status: BackgroundOutcome["status"] = "completed"): BackgroundOutcome => ({ status });

function setup(over: Partial<RunnerDeps> & { cycleMs?: number; outcomes?: BackgroundOutcome[] } = {}) {
  const w = world();
  const lock = lockOf();
  const log = vi.fn();
  const starts: number[] = [];
  const { cycleMs = 40_000, outcomes, ...rest } = over;
  const queue = [...(outcomes ?? [])];
  const deps: RunnerDeps = {
    lock,
    now: w.now,
    sleep: w.sleep,
    heartbeat: (tick) => w.heartbeat(tick),
    log,
    runCycle: async () => { starts.push(w.now()); w.advance(cycleMs); return queue.shift() ?? done(); },
    ...rest,
  };
  return { w, lock, log, starts, deps };
}

describe("the runner lock: only one background runner at a time", () => {
  it("stands down without running a single cycle when another runner holds the lock, and does not release a lock it never held", async () => {
    const { deps, lock, starts } = setup({ lock: lockOf({ acquire: vi.fn(async () => false) }) });
    const r = await runOutreachRunner(deps);
    expect(r).toMatchObject({ status: "busy", cycles: 0 });
    expect(starts).toHaveLength(0);
    expect(deps.lock.release).not.toHaveBeenCalled();
    expect(lock.acquire).not.toHaveBeenCalled(); // (the injected busy lock was used instead)
  });

  it("releases the lock when it finishes normally", async () => {
    const { deps } = setup({ outcomes: [done("disabled")] });
    expect((await runOutreachRunner(deps)).status).toBe("disabled");
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });

  it("never throws: a lock that fails to acquire (Sheets down) is reported as an error and no cycle runs", async () => {
    const { deps, starts, log } = setup({ lock: lockOf({ acquire: vi.fn(async () => { throw new Error("429"); }) }) });
    expect((await runOutreachRunner(deps)).status).toBe("error");
    expect(starts).toHaveLength(0);
    expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/^\[outreach-runner\] \{"status":"error"/);
  });
});

describe("cadence: cycles at the old cron rhythm, bounded below the 15-minute function limit", () => {
  it("starts a cycle every 2 minutes (counting from the START of the previous one) and stops starting new ones before 12 minutes", async () => {
    const { deps, starts, w } = setup({ cycleMs: 40_000 });
    const r = await runOutreachRunner(deps);
    expect(r.status).toBe("time-limit");
    expect(starts).toEqual([0, 120_000, 240_000, 360_000, 480_000, 600_000]);
    expect(r.cycles).toBe(6);
    expect(r.completed).toBe(6);
    expect(w.sleeps.every((s) => s === DEFAULT_CYCLE_INTERVAL_MS - 40_000)).toBe(true);
    // the last cycle starts before the limit and ends long before 15 minutes
    expect(starts.at(-1)! + 55_000 + SETTLE_GRACE_MS).toBeLessThan(15 * 60_000);
    expect(RUNNER_MAX_RUN_MS + 55_000 + SETTLE_GRACE_MS).toBeLessThan(15 * 60_000);
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });

  it("a cycle slower than the interval is followed by a short pause, not an immediate restart", async () => {
    const { deps, w } = setup({ cycleMs: 150_000 });
    await runOutreachRunner(deps);
    expect(w.sleeps.every((s) => s === MIN_CYCLE_GAP_MS)).toBe(true);
  });

  it("a busy cycle (the per-cycle lock is held by a recovering killed run) just waits for the next slot and does not count as a failure", async () => {
    const { deps, starts } = setup({ cycleMs: 1_000, outcomes: [done("busy"), done("busy"), done("busy"), done("busy"), done("busy"), done("completed")] });
    const r = await runOutreachRunner(deps);
    expect(r.status).toBe("time-limit");
    expect(starts.length).toBeGreaterThan(5);
  });

  it("OUTREACH_CYCLE_INTERVAL_S tunes the cadence within 60-600 s and falls back to 2 minutes otherwise", () => {
    expect(cycleIntervalMs({} as never)).toBe(120_000);
    expect(cycleIntervalMs({ OUTREACH_CYCLE_INTERVAL_S: "90" } as never)).toBe(90_000);
    expect(cycleIntervalMs({ OUTREACH_CYCLE_INTERVAL_S: "5" } as never)).toBe(120_000);
    expect(cycleIntervalMs({ OUTREACH_CYCLE_INTERVAL_S: "9999" } as never)).toBe(120_000);
    expect(cycleIntervalMs({ OUTREACH_CYCLE_INTERVAL_S: "abc" } as never)).toBe(120_000);
  });
});

describe("heartbeat: a live runner keeps its lock, a killed one lets it expire", () => {
  it("renews the lock during cycles and during the waits between them, so it never lapses over a 12-minute run", async () => {
    const { deps, lock, w } = setup({ cycleMs: 40_000 });
    await runOutreachRunner(deps);
    expect(w.now()).toBeGreaterThan(10 * 60_000);
    expect(lock.renew.mock.calls.length).toBe(Math.floor(w.now() / RUNNER_HEARTBEAT_MS)); // one beat per heartbeat period, with no gap
    expect(RUNNER_LOCK_TTL_MS).toBeGreaterThan(RUNNER_HEARTBEAT_MS * 2); // survives one missed beat
    expect(RUNNER_LOCK_TTL_MS).toBeGreaterThan(55_000 + SETTLE_GRACE_MS); // and covers a cycle at its hard stop plus the settle grace
  });

  it("stops (after the current cycle) when the renewal says the lock now belongs to someone else", async () => {
    const { deps, starts } = setup({ lock: lockOf({ renew: vi.fn(async () => false) }), cycleMs: 100_000 });
    const r = await runOutreachRunner(deps);
    expect(r.status).toBe("lock-lost");
    expect(starts).toHaveLength(1); // the cycle in flight finished (its own per-cycle lock protects it); no further cycle was started
  });

  it("transient renewal failures (Sheets 429) do not stop a healthy run", async () => {
    let n = 0;
    const flaky = vi.fn(async () => { if (n++ === 0) throw new Error("429"); return true; }); // the first beat fails, later ones succeed
    const { deps, starts } = setup({ lock: lockOf({ renew: flaky }), cycleMs: 5_000, outcomes: [done(), done("disabled")] });
    // the two failed beats stay far below the lock TTL
    expect((await runOutreachRunner(deps)).status).toBe("disabled");
    expect(starts).toHaveLength(2);
    expect(flaky).toHaveBeenCalled();
  });

  it("gives up when the lock could not be renewed for as long as its TTL (it may have expired and been taken)", async () => {
    const { deps, starts } = setup({ lock: lockOf({ renew: vi.fn(async () => { throw new Error("sheets down"); }) }), cycleMs: 5_000 });
    const r = await runOutreachRunner(deps);
    expect(r.status).toBe("lock-lost");
    expect(starts.length).toBeLessThanOrEqual(2);
  });
});

describe("stopping conditions and retries", () => {
  it("stops when outreach is switched off", async () => {
    const { deps, starts } = setup({ outcomes: [done(), done("disabled")] });
    expect((await runOutreachRunner(deps)).status).toBe("disabled");
    expect(starts).toHaveLength(2);
  });

  it(`gives up after ${MAX_CONSECUTIVE_FAILURES} consecutive failing cycles (a later cron call restarts it), but one success resets the count`, async () => {
    const e = done("error");
    const fail3 = setup({ cycleMs: 1_000, outcomes: [e, e, e, done()] });
    expect(await runOutreachRunner(fail3.deps)).toMatchObject({ status: "repeated-errors", cycles: 3, completed: 0 });
    const recovers = setup({ cycleMs: 1_000, outcomes: [e, e, done(), e, e, done("disabled")] });
    expect(await runOutreachRunner(recovers.deps)).toMatchObject({ status: "disabled", cycles: 6, completed: 1 });
  });
});

describe("a cycle that overruns its hard stop is never overlapped", () => {
  it("waits for the abandoned cycle to finish before starting the next one", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => { release = () => { order.push("abandoned cycle finished"); resolve(); }; });
    const { deps, w } = setup({ cycleMs: 1_000 });
    let calls = 0;
    deps.runCycle = async () => {
      calls += 1;
      order.push(`cycle ${calls} starts`);
      if (calls === 1) {
        // the hard stop fired; the work behind it is still running and finishes 10 s later (inside the settle grace)
        setTimeout(release, 5);
        return { status: "timed-out", settled };
      }
      if (calls === 2) return done("disabled");
      return done();
    };
    deps.sleep = async (ms) => { order.push(`sleep ${ms >= SETTLE_GRACE_MS ? "(grace)" : ms}`); await new Promise((r) => setTimeout(r, ms >= SETTLE_GRACE_MS ? 200 : 0)); w.advance(ms); };
    await runOutreachRunner(deps);
    expect(order.indexOf("abandoned cycle finished")).toBeLessThan(order.indexOf("cycle 2 starts"));
  });

  it("if the abandoned cycle never finishes, the runner stops WITHOUT releasing its lock (so no second runner can start beside it) and starts no new cycle", async () => {
    const { deps, starts } = setup({ cycleMs: 1_000, outcomes: [{ status: "timed-out", settled: new Promise<void>(() => undefined) }, done()] });
    deps.sleep = async () => undefined; // the grace period elapses at once
    const r = await runOutreachRunner(deps);
    expect(r.status).toBe("stuck-cycle");
    expect(starts).toHaveLength(1);
    expect(deps.lock.release).not.toHaveBeenCalled(); // the lock expires on its own once the heartbeat has stopped
  });

  it("a timed-out cycle that did not even report a way to wait is treated as stuck", async () => {
    const { deps } = setup({ cycleMs: 1_000, outcomes: [{ status: "timed-out" }] });
    deps.sleep = async () => undefined;
    expect((await runOutreachRunner(deps)).status).toBe("stuck-cycle");
  });
});
