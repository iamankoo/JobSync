/**
 * The Netlify background runner against the REAL lock, send workflow, importer and cycle code on in-memory spreadsheets and a mocked Gmail:
 * nothing real is contacted and no e-mail is sent. Covers concurrent triggers, interruptions, resumption, three members with their own Gmail and
 * résumé, and the 200-import limit across a whole run.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { MemberId } from "@/config/members";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { runOutreachInBackground } from "@/lib/outreach/background";
import { loadOutreachConfig } from "@/lib/outreach/config";
import { OUTREACH_LOCK_TTL_MS, realConnectionsPort, runOutreachCycle, type CycleDeps } from "@/lib/outreach/run";
import { RUNNER_LOCK_TTL_MS, runOutreachRunner, sheetRunnerLock, type RunnerDeps } from "@/lib/outreach/runner";
import { OutreachSheet, RUNNER_LOCK_KEY, RUN_LOCK_KEY } from "@/lib/outreach/sheet";
import { runSendStep } from "@/lib/outreach/send-workflow";
import { TRACKING_TAB } from "@/lib/outreach/types";
import { FakeSheets } from "../helpers/fake-sheets";
import { manyContacts, masterGrid, newOutreachSpreadsheet } from "../helpers/outreach";
import { NOW, buildSendFixture, resumeFile } from "../helpers/send-fixture";

const ALL: MemberId[] = ["anni", "lukky", "rishii"];
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `p${i}@cp${i}.example.com`, name: `Pat Person${i}`, company: `Co${i}`, members: ALL }));
const T0 = NOW.getTime();

/** A virtual clock. Sleeping steps through time heartbeat by heartbeat (each beat's lock renewal is allowed to finish before time moves on), as the real timer would. */
function virtualTime(start = T0, beatMs = 40_000) {
  let t = start;
  let tick: (() => void) | null = null;
  let next = start + beatMs;
  const flush = () => new Promise<void>((r) => setTimeout(r, 25));
  const sleep = async (ms: number) => {
    const end = t + ms;
    while (t < end) {
      const stop = tick ? Math.min(end, next) : end;
      t = stop;
      if (tick && t >= next) { next += beatMs; tick(); await flush(); }
    }
  };
  return { now: () => t, sleep, advance: (ms: number) => { t += ms; }, heartbeat: (fn: () => void) => { tick = fn; next = t + beatMs; return () => { tick = null; }; } };
}

describe("keyed locks on the real state tab", () => {
  const open = async () => {
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(1)));
    await o.sheet.ensureTabs();
    return o;
  };

  it("the runner lock and the per-cycle lock are independent: holding one never blocks the other", async () => {
    const o = await open();
    const runner = new OutreachSheet(o.fake);
    const cycle = new OutreachSheet(o.fake);
    expect(await runner.acquireLock(T0, RUNNER_LOCK_TTL_MS, RUNNER_LOCK_KEY)).toBe(true);
    expect(await cycle.acquireLock(T0, OUTREACH_LOCK_TTL_MS)).toBe(true); // default key = run-lock, as before
    expect(await new OutreachSheet(o.fake).acquireLock(T0, RUNNER_LOCK_TTL_MS, RUNNER_LOCK_KEY)).toBe(false);
    expect(await new OutreachSheet(o.fake).acquireLock(T0, OUTREACH_LOCK_TTL_MS, RUN_LOCK_KEY)).toBe(false);
  });

  it("two simultaneous claimants: exactly one wins", async () => {
    const o = await open();
    const sheets = Array.from({ length: 5 }, () => new OutreachSheet(o.fake));
    const wins = await Promise.all(sheets.map((s) => s.acquireLock(T0, RUNNER_LOCK_TTL_MS, RUNNER_LOCK_KEY)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it("a lock that is renewed stays held past its original expiry; one that is not renewed expires and can be taken (a killed holder frees it)", async () => {
    const o = await open();
    const holder = new OutreachSheet(o.fake);
    expect(await holder.acquireLock(T0, 120_000, RUNNER_LOCK_KEY)).toBe(true);
    expect(await holder.renewLock(T0 + 100_000, 120_000, RUNNER_LOCK_KEY)).toBe(true); // heartbeat: now valid until T0 + 220 s
    expect(await new OutreachSheet(o.fake).acquireLock(T0 + 150_000, 120_000, RUNNER_LOCK_KEY)).toBe(false); // would have expired at T0 + 120 s
    expect(await new OutreachSheet(o.fake).acquireLock(T0 + 221_000, 120_000, RUNNER_LOCK_KEY)).toBe(true); // holder stopped renewing: expired
  });

  it("a holder whose lock expired and was taken learns it: renewal returns false and it does not steal the lock back", async () => {
    const o = await open();
    const old = new OutreachSheet(o.fake);
    await old.acquireLock(T0, 60_000, RUNNER_LOCK_KEY);
    const next = new OutreachSheet(o.fake);
    expect(await next.acquireLock(T0 + 61_000, 60_000, RUNNER_LOCK_KEY)).toBe(true);
    expect(await old.renewLock(T0 + 62_000, 60_000, RUNNER_LOCK_KEY)).toBe(false);
    expect(await next.renewLock(T0 + 62_000, 60_000, RUNNER_LOCK_KEY)).toBe(true);
  });

  it("release frees the lock at once; renewing a lock that was never held is refused", async () => {
    const o = await open();
    const a = new OutreachSheet(o.fake);
    expect(await a.renewLock(T0, 60_000, RUNNER_LOCK_KEY)).toBe(false);
    await a.acquireLock(T0, 60_000, RUNNER_LOCK_KEY);
    await a.releaseLock(T0 + 1_000, RUNNER_LOCK_KEY);
    expect(await new OutreachSheet(o.fake).acquireLock(T0 + 2_000, 60_000, RUNNER_LOCK_KEY)).toBe(true);
  });
});

describe("repeated and concurrent triggers never overlap; every member sends from their own Gmail with their own résumé", () => {
  it("six cron triggers at once start ONE runner; its cycles send all 9 e-mails (3 Connections x 3 members), each exactly once", async () => {
    const f = buildSendFixture(people(3));
    await f.seed();
    let cyclesRunning = 0;
    let maxRunning = 0;
    const mk = (): RunnerDeps => {
      const v = virtualTime();
      let n = 0;
      return {
        lock: sheetRunnerLock(new OutreachSheet(f.fake), () => T0),
        now: v.now, sleep: v.sleep, heartbeat: (tick) => v.heartbeat(tick),
        log: () => undefined,
        runCycle: async () => {
          cyclesRunning += 1;
          maxRunning = Math.max(maxRunning, cyclesRunning);
          await runSendStep(f.deps());
          cyclesRunning -= 1;
          return { status: ++n < 2 ? "completed" : "disabled" }; // a second cycle finds nothing left; then the run ends
        },
      };
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => runOutreachRunner(mk())));
    expect(results.filter((r) => r.status === "busy")).toHaveLength(5);
    expect(results.filter((r) => r.cycles > 0)).toHaveLength(1);
    expect(maxRunning).toBe(1);
    expect(f.ledger().filter((r) => r[3] === "sent")).toHaveLength(9);
    expect(new Set(f.gmail.sendCalls()).size).toBe(9);
    expect(f.gmail.sendCalls()).toHaveLength(9);
    // each member: 3 sends, from that member's own account, with that member's own résumé; never another member's
    for (const m of ALL) {
      const mine = f.ledger().filter((r) => r[4] === m);
      expect(mine).toHaveLength(3);
      expect(mine.every((r) => r[5] === f.gmail.addresses[m] && r[9] === resumeFile(m))).toBe(true);
    }
    // the winner released its lock; the losers' unused claim rows (the lock's existing design) lapse with the TTL, after which the next trigger starts a runner
    expect(await new OutreachSheet(f.fake).acquireLock(T0 + RUNNER_LOCK_TTL_MS + 1, RUNNER_LOCK_TTL_MS, RUNNER_LOCK_KEY)).toBe(true);
  });

  it("no artificial sending cap: 100 Connections -> 300 e-mails go out across the cycles of ONE runner, 100 per member", async () => {
    const f = buildSendFixture(people(100));
    await f.seed();
    const v = virtualTime();
    let n = 0;
    const r = await runOutreachRunner({
      lock: sheetRunnerLock(new OutreachSheet(f.fake), () => T0), now: v.now, sleep: v.sleep, heartbeat: (tick) => v.heartbeat(tick), log: () => undefined,
      runCycle: async () => { await runSendStep(f.deps()); return { status: ++n < 2 ? "completed" : "disabled" }; },
    });
    expect(r.cycles).toBe(2);
    expect(f.ledger().filter((r2) => r2[3] === "sent")).toHaveLength(300);
    for (const m of ALL) expect(f.ledger().filter((r2) => r2[3] === "sent" && r2[4] === m)).toHaveLength(100);
    expect(new Set(f.gmail.sendCalls()).size).toBe(300);
  }, 120_000);
});

describe("interruptions: a killed or stuck run is picked up later without losing work or sending anything twice", () => {
  it("runner A dies mid-send and never releases its lock; a trigger during its TTL stands down; after the TTL a new runner reconciles the crashed send against Gmail and finishes the rest", async () => {
    const f = buildSendFixture(people(3));
    await f.seed();
    let clock = T0;
    const lockAt = () => sheetRunnerLock(new OutreachSheet(f.fake), () => clock);
    const base = { now: () => clock, sleep: async () => undefined, heartbeatMs: 1e9, log: () => undefined };

    // A: the process dies inside the first Gmail call (after the write-ahead claim) and the cycle never settles
    f.gmail.sendScript = ["throw"];
    const a = await runOutreachRunner({ ...base, lock: lockAt(), runCycle: async () => { await runSendStep(f.deps()); return { status: "timed-out", settled: new Promise<void>(() => undefined) }; } });
    expect(a.status).toBe("stuck-cycle");
    expect(f.ledger().map((r) => r[3])).toEqual(["sending"]); // claimed, not confirmed

    // a cron trigger arrives while A's runner lock is still live: it does nothing
    clock = T0 + 60_000;
    const during = await runOutreachRunner({ ...base, lock: lockAt(), runCycle: async () => { throw new Error("must not run"); } });
    expect(during.status).toBe("busy");
    expect(f.gmail.sendCalls()).toHaveLength(1);

    // after the lock has expired a new runner takes over; Gmail proves the crashed send went out
    clock = T0 + RUNNER_LOCK_TTL_MS + 1_000;
    f.clock.now = new Date(NOW.getTime() + 3 * 60_000);
    f.gmail.reconcileScript = [{ state: "sent", messageId: "msg-proved" }];
    const outcomes: Array<"completed" | "disabled"> = ["completed", "disabled"];
    const c = await runOutreachRunner({ ...base, lock: lockAt(), runCycle: async () => { await runSendStep(f.deps()); return { status: outcomes.shift() ?? "disabled" }; } });
    expect(c.cycles).toBe(2);
    const sent = f.ledger().filter((r) => r[3] === "sent");
    expect(sent).toHaveLength(9);
    expect(sent.find((r) => r[14] === "msg-proved")).toBeTruthy(); // recorded once, from Gmail's own message id
    expect(f.gmail.sendCalls()).toHaveLength(9); // the crashed send was NOT sent again
    expect(new Set(f.gmail.sendCalls()).size).toBe(9);
    for (const m of ALL) expect(sent.filter((r) => r[4] === m).every((r) => r[5] === f.gmail.addresses[m] && r[9] === resumeFile(m))).toBe(true);
  });

  it("an uncertain send that cannot be proven stays unresolved over many cycles and many runners and is never retried; everything else still goes out", async () => {
    const f = buildSendFixture(people(3));
    await f.seed();
    f.gmail.sendScript = [{ status: "uncertain", reason: "timeout" }];
    f.gmail.reconcileScript = [{ state: "unknown", reason: "metadata permission missing" }];
    let clock = T0;
    for (let run = 0; run < 3; run++) {
      clock += RUNNER_LOCK_TTL_MS + 1_000;
      f.clock.now = new Date(f.clock.now.getTime() + 24 * 3600_000);
      f.gmail.reconcileScript = [{ state: "unknown", reason: "still unknown" }];
      await runOutreachRunner({ lock: sheetRunnerLock(new OutreachSheet(f.fake), () => clock), now: () => clock, sleep: async () => undefined, heartbeatMs: 1e9, log: () => undefined, runCycle: async () => { await runSendStep(f.deps()); return { status: "disabled" }; } });
    }
    const uncertain = f.ledger().filter((r) => r[3] === "uncertain");
    expect(uncertain).toHaveLength(1);
    expect(f.ledger().filter((r) => r[3] === "sent")).toHaveLength(8);
    expect(f.gmail.sendCalls()).toHaveLength(9); // 9 attempts, the uncertain one exactly once
  });
});

describe("the whole cycle under the runner: the 200-per-24-hours import limit is untouched", () => {
  let prod: FakeSheets;
  afterEach(() => setSheetsClientForTesting(null));

  it("a runner executing six full cycles imports at most 200 contacts in total, then stops importing; manual Connections are unaffected", async () => {
    prod = new FakeSheets().seedMembers();
    setSheetsClientForTesting(prod);
    resetMembersCache();
    invalidateTableCache();
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(260)));
    await o.sheet.ensureTabs();
    const config = loadOutreachConfig({ OUTREACH_ENABLED: "true", OUTREACH_SPREADSHEET_ID: "x", OUTREACH_IMPORT_PER_RUN: "50" } as unknown as NodeJS.ProcessEnv);
    const clock = new Date("2026-11-12T06:00:00.000Z");
    process.env.OUTREACH_ENABLED = "true";
    process.env.OUTREACH_SPREADSHEET_ID = "x";
    const cycleDeps = (): CycleDeps => ({
      config, sheet: new OutreachSheet(o.fake), connections: realConnectionsPort, ledger: async () => new Map(), connected: async () => [], now: () => clock, timezone: "Asia/Kolkata",
    });
    const v = virtualTime();
    const r = await runOutreachRunner({
      lock: sheetRunnerLock(new OutreachSheet(o.fake), v.now), now: v.now, sleep: v.sleep, heartbeat: (tick) => v.heartbeat(tick), log: () => undefined,
      runCycle: () => runOutreachInBackground({ build: cycleDeps, run: runOutreachCycle, log: () => undefined }),
      maxRunMs: 6 * 120_000 - 1, // six cycles at the 2-minute cadence
    });
    expect(r.cycles).toBe(6);
    expect(r.status).toBe("time-limit");
    const imported = o.fake.dataRows(TRACKING_TAB).filter((row) => row[0] && row[2] === "outreach-database" && row[3] === "added");
    expect(imported).toHaveLength(200); // never 201, never 260
    delete process.env.OUTREACH_ENABLED;
    delete process.env.OUTREACH_SPREADSHEET_ID;
  }, 120_000);
});
