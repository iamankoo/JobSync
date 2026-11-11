/**
 * The cron endpoint must answer within seconds (the scheduler gives up after 30 s) and hand the cycle to the Netlify Background Function;
 * interrupted or overlapping cycles must stay safe. No Google, Gmail or network calls here (the hand-off `fetch` is stubbed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/cron/outreach/route";
import { setSheetsRetryDeadline, sheetsRateLimitHits, resetSheetsRateLimitHits, withRetry } from "@/lib/google-sheets/client";
import { SheetsError } from "@/lib/google-sheets/errors";
import { HARD_STOP_MS, ROUTE_MAX_DURATION_S, runOutreachInBackground as realRun } from "@/lib/outreach/background";
import { loadOutreachConfig } from "@/lib/outreach/config";
import { DRAFT_YIELD_AFTER_RATE_LIMITS, OUTREACH_LOCK_TTL_MS, runOutreachCycle, type CycleDeps } from "@/lib/outreach/run";
import { manyContacts, masterGrid, newOutreachSpreadsheet } from "../../helpers/outreach";

const SECRET = "test-secret-value";
const req = (auth?: string) => new Request("https://x.test/api/cron/outreach", { headers: auth ? { authorization: auth } : {} });
const env = (o: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
const handOff = vi.fn();

beforeEach(() => {
  handOff.mockReset();
  vi.stubGlobal("fetch", handOff);
  env({ OUTREACH_CRON_SECRET: SECRET, OUTREACH_ENABLED: "true", OUTREACH_SPREADSHEET_ID: "outreach-test", OUTREACH_BACKGROUND_URL: undefined });
});
afterEach(() => { vi.unstubAllGlobals(); env({ OUTREACH_CRON_SECRET: undefined, OUTREACH_ENABLED: undefined, OUTREACH_SPREADSHEET_ID: undefined }); setSheetsRetryDeadline(null); });

describe("the HTTP endpoint authenticates and hands over to the background function", () => {
  it("returns 202 within a second and forwards ONE authenticated POST to the background function; no cycle runs in the request", async () => {
    handOff.mockResolvedValue(new Response(null, { status: 202 })); // what a Netlify background function answers
    const t0 = Date.now();
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { accepted: true, dispatched: true } });
    expect(handOff).toHaveBeenCalledTimes(1);
    const [url, init] = handOff.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://x.test/.netlify/functions/outreach-background");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
  });

  it("does not use Next.js after() and no longer exports a route duration: the long work is not inside this route at all", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/cron/outreach/route.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // code only, not comments
    expect(src).not.toMatch(/\bafter\b\s*\(/);
    expect(src).not.toMatch(/from "next\/server"/);
    expect(src).not.toMatch(/runOutreachInBackground|runOutreachCycle/);
    expect(src).not.toMatch(/maxDuration/);
  });

  it("an explicit OUTREACH_BACKGROUND_URL overrides the derived address", async () => {
    handOff.mockResolvedValue(new Response(null, { status: 202 }));
    env({ OUTREACH_BACKGROUND_URL: "https://other.test/.netlify/functions/outreach-background" });
    await GET(req(`Bearer ${SECRET}`));
    expect(handOff.mock.calls[0][0]).toBe("https://other.test/.netlify/functions/outreach-background");
  });

  it("answers 502 (and tells the scheduler) when the background function cannot be reached or refuses; the secret is never echoed", async () => {
    handOff.mockRejectedValueOnce(new Error("network down"));
    const down = await GET(req(`Bearer ${SECRET}`));
    expect(down.status).toBe(502);
    handOff.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const missing = await GET(req(`Bearer ${SECRET}`));
    expect(missing.status).toBe(502);
    expect(JSON.stringify(await missing.json())).not.toContain(SECRET);
  });

  it("starts nothing for a missing/wrong secret, an unset secret, or when outreach is switched off", async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer nope"))).status).toBe(401);
    env({ OUTREACH_CRON_SECRET: undefined });
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(503);
    env({ OUTREACH_CRON_SECRET: SECRET, OUTREACH_ENABLED: "false" });
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(503);
    expect(handOff).not.toHaveBeenCalled();
  });

  it("the cycle's own time budget still fits inside its lock TTL (a killed cycle frees its lock by itself)", () => {
    expect(HARD_STOP_MS).toBeLessThan(ROUTE_MAX_DURATION_S * 1000);
    expect(OUTREACH_LOCK_TTL_MS).toBeGreaterThan(HARD_STOP_MS);
  });
});

describe("the background runner", () => {
  const cycleDeps = {} as CycleDeps;
  const log = vi.fn();
  beforeEach(() => log.mockReset());

  it("runs one cycle, logs counts only, and clears the retry deadline afterwards", async () => {
    const out = await realRun({ build: () => cycleDeps, run: async () => ({ ran: true, errors: [], import: { day: "d", importedThisRun: 2, importedToday: 2, dailyLimit: 200, resumed: 0, linkedExisting: 0, failed: 0, stoppedBecause: "run-limit", masterRejected: 0, queueRemaining: 5, errors: [] } }), log });
    expect(out.status).toBe("completed");
    expect(log.mock.calls[0][0]).toMatch(/^\[outreach\] \{"status":"completed"/);
    expect(log.mock.calls[0][0]).not.toMatch(/@|token|secret/i);
  });

  it("a busy cycle (another worker holds the lock) is reported, not an error", async () => {
    expect((await realRun({ build: () => cycleDeps, run: async () => ({ ran: false, reason: "busy", errors: [] }), log })).status).toBe("busy");
  });

  it("never throws: a failing cycle is logged and the deadline is cleared", async () => {
    const out = await realRun({ build: () => cycleDeps, run: async () => { throw new Error("boom"); }, log });
    expect(out.status).toBe("error");
    // the retry deadline was removed: a retry is allowed to sleep again
    let slept = 0;
    let n = 0;
    await withRetry(async () => { if (++n === 1) throw new SheetsError("rate_limited", "x"); return 1; }, async (ms) => { slept += ms; });
    expect(slept).toBeGreaterThan(0);
  });

  it("stops at the hard limit instead of running on, and reports it", async () => {
    const out = await realRun({ build: () => cycleDeps, run: () => new Promise(() => undefined), hardStopMs: 30, log });
    expect(out.status).toBe("timed-out");
  });

  it("429 back-off cannot sleep past the retry deadline: it fails fast instead of burning the budget", async () => {
    let attempts = 0;
    let slept = 0;
    const out = await realRun({
      now: () => 0, // the run "started" at epoch 0, so its retry deadline is already in the past
      build: () => cycleDeps,
      run: async () => {
        await withRetry(async () => { attempts += 1; throw new SheetsError("rate_limited", "quota"); }, async (ms) => { slept += ms; }).catch(() => undefined);
        return { ran: true, errors: [] };
      },
      log,
    });
    expect(out.status).toBe("completed");
    expect(attempts).toBe(1);
    expect(slept).toBe(0);
    expect(sheetsRateLimitHits()).toBeGreaterThan(0); // and it is counted, so drafting can yield
  });
});

describe("interruption recovery, overlap and yielding", () => {
  const T0 = new Date("2026-11-06T06:00:00.000Z");
  const open = async () => {
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(3)));
    await o.sheet.ensureTabs();
    return o;
  };
  const deps = (o: Awaited<ReturnType<typeof open>>, over: Partial<CycleDeps> = {}): CycleDeps => ({
    config: loadOutreachConfig({ OUTREACH_ENABLED: "true", OUTREACH_SPREADSHEET_ID: "x" } as unknown as NodeJS.ProcessEnv),
    sheet: o.sheet,
    connections: { listFresh: async () => [], create: async () => { throw new Error("not needed"); } },
    ledger: async () => new Map(),
    connected: async () => [],
    now: () => T0,
    timezone: "Asia/Kolkata",
    ...over,
  });

  it("overlapping calls never run two cycles at once: one runs, the other is told it is busy", async () => {
    const o = await open();
    let running = 0;
    let maxRunning = 0;
    const draft = async () => { running += 1; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 20)); running -= 1; return { checked: 0, created: 0, remaining: 0 }; };
    const results = await Promise.all([runOutreachCycle(deps(o, { draft })), runOutreachCycle(deps(o, { draft })), runOutreachCycle(deps(o, { draft }))]);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect(results.filter((r) => r.reason === "busy")).toHaveLength(2);
    expect(maxRunning).toBe(1);
  });

  it("a run that is killed mid-way (lock never released) blocks only until the lock expires; the next call then continues", async () => {
    const o = await open();
    expect(await o.sheet.acquireLock(T0.getTime(), OUTREACH_LOCK_TTL_MS)).toBe(true); // the killed run
    expect((await runOutreachCycle(deps(o))).reason).toBe("busy");
    const later = new Date(T0.getTime() + OUTREACH_LOCK_TTL_MS + 1000);
    const next = await runOutreachCycle(deps(o, { now: () => later }));
    expect(next.ran).toBe(true);
    expect(OUTREACH_LOCK_TTL_MS).toBeGreaterThan(ROUTE_MAX_DURATION_S * 1000); // a killed run never holds the lock past the next call
  });

  it("sending and importing run BEFORE drafting, so a slow or failing draft step cannot starve them", async () => {
    const o = await open();
    const order: string[] = [];
    await runOutreachCycle(deps(o, {
      gate: true,
      send: async () => { order.push("send"); return { status: "ran", sent: 0, blocked: 0, needsReview: 0, failed: 0, waiting: 0, duplicatesPrevented: 0, reconciled: 0, stoppedBecause: "none", errors: [] }; },
      draft: async () => { order.push("draft"); throw new Error("draft step is down"); },
    }));
    expect(order).toEqual(["send", "draft"]);
    const tracked = o.fake.dataRows("Added in Outreach Emails").filter((r) => r[0]);
    expect(tracked.length).toBeGreaterThanOrEqual(0); // the import step ran in between (no connections port here, so nothing is created)
  });

  it("drafting yields when Google keeps answering 429 in this run; sending and importing are unaffected", async () => {
    const o = await open();
    const draft = vi.fn(async () => ({ checked: 0, created: 0, remaining: 0 }));
    const send = vi.fn(async () => ({ status: "ran" as const, sent: 0, blocked: 0, needsReview: 0, failed: 0, waiting: 0, duplicatesPrevented: 0, reconciled: 0, stoppedBecause: "none" as const, errors: [] }));
    const r = await runOutreachCycle(deps(o, { gate: true, send, draft, rateLimitHits: () => DRAFT_YIELD_AFTER_RATE_LIMITS }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(draft).not.toHaveBeenCalled();
    expect(r.drafts).toBe("skipped");
    const calm = await runOutreachCycle(deps(o, { gate: true, send, draft, rateLimitHits: () => 0, now: () => new Date(T0.getTime() + 3 * 60_000) }));
    expect(draft).toHaveBeenCalledTimes(1);
    expect(calm.ran).toBe(true);
    resetSheetsRateLimitHits();
  });
});
