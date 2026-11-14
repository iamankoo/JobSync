/**
 * SEND-FIRST MODE: when 50 or more real, eligible JobSync drafts are saved in the members' Gmail, a cycle does nothing but send them (no manual-Connection
 * registration, no adoption of old drafts, no import, no drafting), with a long send slice, and the runner repeats such cycles back-to-back. If those cycles
 * stop sending anything, normal work resumes. In-memory spreadsheets and mock ports only: nothing real is contacted and no e-mail is sent.
 */
import { describe, expect, it, vi } from "vitest";
import type { MemberId } from "@/config/members";
import { DRAFT_BACKLOG_LIMIT } from "@/lib/gmail/draft-backlog";
import { HARD_STOP_MS, runOutreachInBackground } from "@/lib/outreach/background";
import { DEFAULT_SEND_FIRST_AT, loadOutreachConfig } from "@/lib/outreach/config";
import { OUTREACH_LOCK_TTL_MS, SEND_FIRST_SLICE_MS, SEND_SLICE_BACKLOG_MS, SEND_SLICE_MS, runOutreachCycle, type CycleDeps } from "@/lib/outreach/run";
import {
  MIN_CYCLE_GAP_MS, RUNNER_HEARTBEAT_MS, RUNNER_LOCK_TTL_MS, RUNNER_MAX_RUN_MS, SEND_FIRST_IDLE_LIMIT, SEND_FIRST_NORMAL_EVERY, SETTLE_GRACE_MS, runOutreachRunner, type RunnerDeps,
} from "@/lib/outreach/runner";
import { runSendStep, type SendRunResult } from "@/lib/outreach/send-workflow";
import { DAILY_IMPORT_LIMIT } from "@/lib/outreach/types";
import { manyContacts, masterGrid, newOutreachSpreadsheet } from "../../helpers/outreach";
import { NOW, buildSendFixture, resumeFile } from "../../helpers/send-fixture";

const ALL: MemberId[] = ["anni", "lukky", "rishii"];
const env = (o: Record<string, string>) => ({ OUTREACH_ENABLED: "true", OUTREACH_SPREADSHEET_ID: "x", ...o }) as unknown as NodeJS.ProcessEnv;
const emptySend = (sent = 0): SendRunResult => ({ status: "ran", sent, blocked: 0, needsReview: 0, failed: 0, waiting: 0, duplicatesPrevented: 0, reconciled: 0, stoppedBecause: "none", errors: [] });

describe("configuration", () => {
  it("defaults to 50, can be switched off with 0, and ignores nonsense", () => {
    expect(DEFAULT_SEND_FIRST_AT).toBe(50);
    expect(loadOutreachConfig(env({})).sendFirstAt).toBe(50);
    expect(loadOutreachConfig(env({ OUTREACH_SEND_FIRST_AT: "" })).sendFirstAt).toBe(50);
    expect(loadOutreachConfig(env({ OUTREACH_SEND_FIRST_AT: "0" })).sendFirstAt).toBe(0);
    expect(loadOutreachConfig(env({ OUTREACH_SEND_FIRST_AT: "20" })).sendFirstAt).toBe(20);
    for (const bad of ["abc", "-3", "2.5", "5000", "NaN"]) expect(loadOutreachConfig(env({ OUTREACH_SEND_FIRST_AT: bad })).sendFirstAt).toBe(50);
  });
  it("the other limits are untouched: 200 imports per rolling 24 h, and the separate 100-draft rule for drafting", () => {
    expect(DAILY_IMPORT_LIMIT).toBe(200);
    expect(DRAFT_BACKLOG_LIMIT).toBe(100);
    expect(DEFAULT_SEND_FIRST_AT).toBeLessThan(DRAFT_BACKLOG_LIMIT);
    expect(loadOutreachConfig(env({ OUTREACH_DAILY_LIMIT: "999" })).dailyLimit).toBe(200);
  });
});

describe("the cycle", () => {
  const T0 = new Date("2026-11-12T06:00:00.000Z");
  const open = async () => {
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(6)));
    await o.sheet.ensureTabs();
    return o;
  };
  function build(o: Awaited<ReturnType<typeof open>>, over: Partial<CycleDeps> = {}, cfg: Record<string, string> = {}) {
    const send = vi.fn<(opts?: { sendFirst?: boolean }) => Promise<SendRunResult>>(async () => emptySend());
    const draft = vi.fn(async () => ({ checked: 0, created: 0, remaining: 0 }));
    const create = vi.fn(async () => { throw new Error("no connection is created in these tests"); });
    const listFresh = vi.fn(async () => []);
    const deps: CycleDeps = {
      config: loadOutreachConfig(env(cfg)),
      sheet: o.sheet,
      connections: { listFresh, create },
      ledger: async () => new Map(),
      connected: async () => ALL,
      send,
      draft,
      gate: true,
      now: () => T0,
      timezone: "Asia/Kolkata",
      ...over,
    };
    return { deps, send, draft, create, listFresh };
  }

  it("at 50 or more saved drafts it ONLY sends: no manual registration, no adoption, no import, no drafting", async () => {
    const o = await open();
    const { deps, send, draft, create } = build(o, { savedDrafts: async () => 50 });
    const r = await runOutreachCycle(deps);
    expect(r.mode).toBe("send-first");
    expect(r.savedDrafts).toBe(50);
    expect(send).toHaveBeenCalledWith({ sendFirst: true });
    expect(draft).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled(); // the importer would have created Connections
    expect(r.manual).toBeUndefined();
    expect(r.existing).toBeUndefined();
    expect(r.import).toBeUndefined();
    expect(r.drafts).toBe("skipped");
    expect(o.fake.dataRows("Added in Outreach Emails").filter((x) => x[0])).toHaveLength(0); // nothing was imported or registered
  });

  it("at 49 it is the normal cycle: everything runs, with the normal send slice", async () => {
    const o = await open();
    const { deps, send, draft } = build(o, { savedDrafts: async () => 49 });
    const r = await runOutreachCycle(deps);
    expect(r.mode).toBe("normal");
    expect(send).toHaveBeenCalledWith({ sendFirst: false });
    expect(r.manual).toBeDefined();
    expect(r.import).toBeDefined();
    expect(draft).toHaveBeenCalled();
  });

  it("the threshold is configurable and 0 switches the mode off", async () => {
    const o = await open();
    expect((await runOutreachCycle(build(o, { savedDrafts: async () => 20 }, { OUTREACH_SEND_FIRST_AT: "20" }).deps)).mode).toBe("send-first");
    expect((await runOutreachCycle(build(o, { savedDrafts: async () => 900 }, { OUTREACH_SEND_FIRST_AT: "0" }).deps)).mode).toBe("normal");
  });

  it("a count that cannot be obtained never switches the mode on: the normal cycle runs (and the 100-draft gate fails closed for drafting as before)", async () => {
    const o = await open();
    for (const savedDrafts of [async () => null, async () => { throw new Error("Gmail down"); }, undefined]) {
      const { deps, send } = build(o, { ...(savedDrafts ? { savedDrafts } : {}) });
      const r = await runOutreachCycle(deps);
      expect(r.mode).toBe("normal");
      expect(r.savedDrafts).toBeUndefined();
      expect(send).toHaveBeenCalledWith({ sendFirst: false });
    }
  });

  it("with sending disabled (the compile-time gate) the mode can never start, whatever the count", async () => {
    const o = await open();
    const { deps, send } = build(o, { gate: false, savedDrafts: async () => 900 });
    const r = await runOutreachCycle(deps);
    expect(r.mode).toBe("normal");
    expect(send).not.toHaveBeenCalled();
  });

  it("the bookkeeping that follows sending still runs in send-first mode (status sync, notifications, counters) and the lock is released", async () => {
    const o = await open();
    const notify = vi.fn(async () => "done" as const);
    const { deps, listFresh } = build(o, { savedDrafts: async () => 80, notify });
    const r = await runOutreachCycle(deps);
    expect(r.mode).toBe("send-first");
    expect(listFresh).toHaveBeenCalled(); // the tracking status sync
    expect(r.counters).toBeDefined();
    expect(r.errors).toEqual([]);
    expect((await runOutreachCycle(build(o, { savedDrafts: async () => 80 }).deps)).ran).toBe(true); // the lock was released
  });

  it("send-first is not stuck on the 200-import allowance or any other limit: nothing is imported, so nothing is counted against it", async () => {
    const o = await open();
    const r = await runOutreachCycle(build(o, { savedDrafts: async () => 120 }).deps);
    expect(r.import).toBeUndefined();
    expect(r.counters?.importedToday).toBe(0);
  });
});

describe("send-first mode actually sends everything, from every member's own account with their own résumé", () => {
  it("20 Connections x 3 members = 60 e-mails in ONE cycle, each exactly once, nothing imported or drafted", async () => {
    const people = Array.from({ length: 20 }, (_, i) => ({ email: `p${i}@cp${i}.example.com`, name: `Pat Person${i}`, company: `Co${i}`, members: ALL }));
    const f = buildSendFixture(people);
    await f.seed();
    const create = vi.fn(async () => { throw new Error("must not import"); });
    const draft = vi.fn(async () => ({ checked: 0, created: 0, remaining: 0 }));
    const deps: CycleDeps = {
      config: loadOutreachConfig(env({})),
      sheet: f.sheet,
      connections: { listFresh: async () => [...f.connections.values()], create },
      ledger: async () => new Map(),
      connected: async () => ALL,
      send: () => runSendStep(f.deps()),
      draft,
      savedDrafts: async () => 60,
      gate: true,
      now: () => NOW,
      timezone: "Asia/Kolkata",
    };
    const r = await runOutreachCycle(deps);
    expect(r.mode).toBe("send-first");
    expect(r.send?.sent).toBe(60);
    expect(create).not.toHaveBeenCalled();
    expect(draft).not.toHaveBeenCalled();
    const sent = f.ledger().filter((x) => x[3] === "sent");
    expect(sent).toHaveLength(60);
    expect(new Set(f.gmail.sendCalls()).size).toBe(60);
    for (const m of ALL) {
      const mine = sent.filter((x) => x[4] === m);
      expect(mine).toHaveLength(20);
      expect(mine.every((x) => x[5] === f.gmail.addresses[m] && x[9] === resumeFile(m) && x[14] !== "")).toBe(true);
    }
  }, 120_000);
});

describe("the background wrapper", () => {
  it("reports the mode and the number of confirmed sends of a completed cycle", async () => {
    process.env.OUTREACH_ENABLED = "true";
    process.env.OUTREACH_SPREADSHEET_ID = "x";
    try {
      const log = vi.fn();
      const out = await runOutreachInBackground({
        build: () => ({}) as CycleDeps,
        run: async () => ({ ran: true, mode: "send-first", savedDrafts: 72, errors: [], send: emptySend(7) }),
        log,
      });
      expect(out).toMatchObject({ status: "completed", mode: "send-first", sent: 7 });
      expect(log.mock.calls[0][0]).toMatch(/"mode":"send-first","saved":72/);
    } finally {
      delete process.env.OUTREACH_ENABLED;
      delete process.env.OUTREACH_SPREADSHEET_ID;
    }
  });
  it("noSendFirst gives the cycle a config with the mode switched off (and leaves everything else as configured)", async () => {
    process.env.OUTREACH_ENABLED = "true";
    process.env.OUTREACH_SPREADSHEET_ID = "x";
    try {
      const seen: number[] = [];
      for (const noSendFirst of [false, true]) {
        await runOutreachInBackground({ noSendFirst, build: (_b, cfg) => { seen.push(cfg.sendFirstAt); return {} as CycleDeps; }, run: async () => ({ ran: true, errors: [] }), log: () => undefined });
      }
      expect(seen).toEqual([50, 0]);
    } finally {
      delete process.env.OUTREACH_ENABLED;
      delete process.env.OUTREACH_SPREADSHEET_ID;
    }
  });
});

describe("time budgets", () => {
  it("a send-first cycle fits inside its hard stop and its locks, and the whole runner fits inside the 15-minute function limit", () => {
    const longestAttempt = 15_000; // one send attempt may start just before the slice ends
    const wrapUp = 30_000; // park notes, status sync, notifications, counters
    expect(SEND_FIRST_SLICE_MS).toBeGreaterThan(SEND_SLICE_BACKLOG_MS);
    expect(SEND_FIRST_SLICE_MS).toBeGreaterThan(SEND_SLICE_MS);
    expect(SEND_FIRST_SLICE_MS + longestAttempt + wrapUp).toBeLessThan(HARD_STOP_MS);
    expect(OUTREACH_LOCK_TTL_MS).toBeGreaterThan(HARD_STOP_MS);
    expect(RUNNER_LOCK_TTL_MS).toBeGreaterThan(HARD_STOP_MS + SETTLE_GRACE_MS + RUNNER_HEARTBEAT_MS);
    expect(RUNNER_MAX_RUN_MS + HARD_STOP_MS + SETTLE_GRACE_MS).toBeLessThan(15 * 60_000);
  });
});

describe("the runner", () => {
  function world() {
    let t = 0;
    let tick: (() => void) | null = null;
    let next = 40_000;
    const sleeps: number[] = [];
    return {
      now: () => t,
      advance: (ms: number) => { t += ms; while (tick && next <= t) { next += 40_000; tick(); } },
      sleeps,
      sleep: async (ms: number) => { sleeps.push(ms); t += ms; while (tick && next <= t) { next += 40_000; tick(); } },
      heartbeat: (fn: () => void) => { tick = fn; return () => { tick = null; }; },
    };
  }
  function run(script: Array<{ mode: "normal" | "send-first"; sent: number }>, cycleMs = 60_000) {
    const w = world();
    const calls: boolean[] = [];
    const queue = [...script];
    const deps: RunnerDeps = {
      lock: { acquire: async () => true, renew: async () => true, release: async () => undefined },
      now: w.now, sleep: w.sleep, heartbeat: (tick) => w.heartbeat(tick), log: () => undefined,
      runCycle: async (o) => {
        calls.push(o.noSendFirst);
        w.advance(cycleMs);
        const n = queue.shift();
        // A cycle told noSendFirst runs in normal mode (as the real cycle does).
        return n ? { status: "completed", mode: o.noSendFirst ? "normal" : n.mode, sent: n.sent } : { status: "disabled" };
      },
    };
    return { deps, calls, w };
  }

  it("send-first cycles follow each other after only a short pause (draining), normal cycles keep the 2-minute rhythm", async () => {
    const sf = run([{ mode: "send-first", sent: 5 }, { mode: "send-first", sent: 4 }, { mode: "send-first", sent: 3 }]);
    await runOutreachRunner(sf.deps);
    expect(sf.w.sleeps.length).toBeGreaterThanOrEqual(3);
    expect(sf.w.sleeps.slice(0, 3).every((s) => s === MIN_CYCLE_GAP_MS)).toBe(true);
    const normal = run([{ mode: "normal", sent: 1 }, { mode: "normal", sent: 1 }], 40_000);
    await runOutreachRunner(normal.deps);
    expect(normal.w.sleeps[0]).toBe(120_000 - 40_000);
  });

  it(`after ${SEND_FIRST_IDLE_LIMIT} send-first cycles that send nothing it stops using the mode for the rest of the run, so imports and drafting resume`, async () => {
    const r = run([{ mode: "send-first", sent: 0 }, { mode: "send-first", sent: 0 }, { mode: "normal", sent: 0 }]);
    const out = await runOutreachRunner(r.deps);
    expect(r.calls).toEqual([false, false, true, true]); // the third and later cycles are told noSendFirst
    expect(out.sendFirstSuspended).toBe(true);
    expect(out.sendFirstCycles).toBe(2);
  });

  it("a send-first cycle that does send resets the count, so a draining backlog is never suspended", async () => {
    const r = run([{ mode: "send-first", sent: 0 }, { mode: "send-first", sent: 3 }, { mode: "send-first", sent: 0 }, { mode: "send-first", sent: 2 }]);
    const out = await runOutreachRunner(r.deps);
    expect(out.sendFirstSuspended).toBe(false);
    // The third call is the interleaved normal cycle (see below), not a suspension: send-first resumes right after it.
    expect(r.calls).toEqual([false, false, true, false, false]);
  });

  it(`one member's backlog never stops the others: after ${SEND_FIRST_NORMAL_EVERY} send-first cycles in a row, ONE normal cycle (import, drafting) runs, then send-first resumes`, async () => {
    const sf = { mode: "send-first" as const, sent: 4 };
    const r = run([sf, sf, sf, sf, sf, sf, sf]);
    const out = await runOutreachRunner(r.deps);
    expect(r.calls).toEqual([false, false, true, false, false, true, false, false]);
    expect(out.interleaved).toBe(2);
    expect(out.sendFirstSuspended).toBe(false);
    expect(r.w.sleeps.slice(0, 6).every((s) => s === MIN_CYCLE_GAP_MS)).toBe(true); // still draining back-to-back
  });

  it("normal-mode cycles never count towards the valve", async () => {
    const r = run([{ mode: "normal", sent: 0 }, { mode: "normal", sent: 0 }, { mode: "normal", sent: 0 }]);
    const out = await runOutreachRunner(r.deps);
    expect(out.sendFirstSuspended).toBe(false);
    expect(out.sendFirstCycles).toBe(0);
  });
});
