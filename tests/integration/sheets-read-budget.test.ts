/**
 * Google Sheets allows only ~60 reads per minute per user, shared by the whole app. In production the outreach cycle hit that limit constantly
 * (HTTP 429 on 8-11 calls per run, 16 of 20 runs hit the 55 s hard stop, ~495 review contacts re-checked on every call, imports and drafting starved).
 * These tests pin the savings so they cannot quietly regress.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cachedAccess, forgetAccess, rememberAccess, ACCESS_TTL_MS } from "@/lib/gmail/access-cache";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { eligibleIdSet, firstInDuplicateGroups, parseMasterRows } from "@/lib/outreach/contacts";
import { runOutreachImport } from "@/lib/outreach/importer";
import { REVIEW_RECHECK_EVERY, realConnectionsPort } from "@/lib/outreach/run";
import { runSendStep } from "@/lib/outreach/send-workflow";
import { FakeSheets } from "../helpers/fake-sheets";
import { manyContacts, masterGrid, newOutreachSpreadsheet } from "../helpers/outreach";
import { buildSendFixture, type ContactSpec } from "../helpers/send-fixture";

const reads = (fake: FakeSheets) => {
  const counts: Record<string, number> = {};
  const orig = fake.getValues.bind(fake);
  fake.getValues = async (range: string) => {
    const k = range.split("!")[0].replace(/'/g, "");
    counts[k] = (counts[k] ?? 0) + 1;
    return orig(range);
  };
  return counts;
};

afterEach(() => setSheetsClientForTesting(null));

describe("importer: nothing to import -> nothing big is read", () => {
  it("when the 24-hour allowance is used up, neither Master Contacts (15,000+ rows) nor Connections is read", async () => {
    const prod = new FakeSheets().seedMembers();
    setSheetsClientForTesting(prod);
    resetMembersCache();
    invalidateTableCache();
    const outreach = newOutreachSpreadsheet(masterGrid(manyContacts(30)));
    await outreach.sheet.ensureTabs();
    const now = new Date("2026-11-05T05:00:00.000Z");
    const deps = { sheet: outreach.sheet, connections: realConnectionsPort, now: () => now, timezone: "Asia/Kolkata", dailyLimit: 5, perRun: 50 };
    expect((await runOutreachImport(deps)).importedThisRun).toBe(5);
    const outreachReads = reads(outreach.fake);
    const prodReads = reads(prod);
    const r = await runOutreachImport(deps);
    expect(r).toMatchObject({ importedThisRun: 0, importedToday: 5, stoppedBecause: "daily-limit" });
    expect(outreachReads["Master Contacts"] ?? 0).toBe(0);
    expect(prodReads["Connections"] ?? 0).toBe(0);
    expect(outreachReads["Added in Outreach Emails"]).toBe(1); // only the small tracking tab is needed to know the allowance is used up
  });

  it("an interrupted claim is still finished even when the allowance is used up (the early exit never skips recovery)", async () => {
    const prod = new FakeSheets().seedMembers();
    setSheetsClientForTesting(prod);
    resetMembersCache();
    invalidateTableCache();
    const outreach = newOutreachSpreadsheet(masterGrid(manyContacts(10)));
    await outreach.sheet.ensureTabs();
    const now = new Date("2026-11-05T05:00:00.000Z");
    const deps = { sheet: outreach.sheet, connections: realConnectionsPort, now: () => now, timezone: "Asia/Kolkata", dailyLimit: 3, perRun: 50 };
    await runOutreachImport(deps);
    const row = outreach.fake.tabs.get("Added in Outreach Emails")![1];
    row[3] = "importing"; // simulate a crash between claim and Connection creation
    outreach.fake.tabs.get("Added in Outreach Emails")![1] = row;
    const outreachReads = reads(outreach.fake);
    await runOutreachImport(deps);
    expect(outreachReads["Master Contacts"]).toBeGreaterThanOrEqual(1); // recovery needs the full picture
  });
});

describe("Master Contacts is parsed once per cached grid", () => {
  it("the same grid object gives the very same parsed result; a fresh grid is parsed afresh", () => {
    const grid = masterGrid(manyContacts(50));
    const a = parseMasterRows(grid);
    expect(parseMasterRows(grid)).toBe(a);
    expect(firstInDuplicateGroups(a.contacts)).toBe(firstInDuplicateGroups(a.contacts));
    expect(eligibleIdSet(a)).toBe(eligibleIdSet(a));
    expect(eligibleIdSet(a).size).toBe(50);
    const copy = grid.map((r) => [...r]);
    expect(parseMasterRows(copy)).not.toBe(a);
    expect(parseMasterRows(copy).contacts).toHaveLength(a.contacts.length);
  });
});

describe("Gmail access is remembered for 90 seconds, and only while nothing changes", () => {
  it("a lookup is reused until it expires, one member's entry is independent of another's, and forgetting works", () => {
    forgetAccess();
    expect(cachedAccess("anni", 0)).toBeUndefined();
    rememberAccess("anni", { ok: true, token: "t1" }, 1_000);
    expect(cachedAccess("anni", 1_000 + ACCESS_TTL_MS - 1)).toEqual({ ok: true, token: "t1" });
    expect(cachedAccess("lukky", 1_500)).toBeUndefined();
    expect(cachedAccess("anni", 1_000 + ACCESS_TTL_MS)).toBeUndefined(); // expired
    rememberAccess("anni", { ok: true, token: "t2" }, 5_000);
    forgetAccess("anni");
    expect(cachedAccess("anni", 5_001)).toBeUndefined();
    rememberAccess("rishii", { ok: true, token: "t3" }, 6_000);
    forgetAccess();
    expect(cachedAccess("rishii", 6_001)).toBeUndefined();
  });

  it("replacing the Sheets client (tests, restarts) forgets everything", () => {
    rememberAccess("anni", { ok: true, token: "x" });
    setSheetsClientForTesting(null);
    expect(cachedAccess("anni")).toBeUndefined();
  });
});

describe("contacts already in review are re-checked only occasionally, so they cannot use up every call", () => {
  const ALL = ["anni", "lukky", "rishii"] as const;
  /** 5 OLD contacts whose drafts have no resume at all (they end up in review) followed by 3 NEWER good ones. */
  async function setup() {
    const specs: ContactSpec[] = Array.from({ length: 8 }, (_, i) => ({ email: `p${i}@c${i}.example.com`, name: `Pat Person${i}`, company: `Co${i}`, members: [...ALL] }));
    const f = buildSendFixture(specs);
    for (let i = 0; i < 5; i++) {
      for (const m of ALL) {
        const d = f.gmail.drafts.get(`draft_${i}_${m}`) as { status: "ok"; draft: { attachments: unknown[] } };
        f.gmail.drafts.set(`draft_${i}_${m}`, { status: "ok", draft: { ...d.draft, attachments: [] } } as never);
      }
    }
    await f.seed();
    return f;
  }
  const readsOf = (f: Awaited<ReturnType<typeof setup>>) => f.gmail.calls.filter((c) => c.startsWith("read:")).length;
  const slot = (f: Awaited<ReturnType<typeof setup>>) => { f.clock.now = new Date(f.clock.now.getTime() + 120_000); };

  it("production re-checks review contacts about every 30 minutes", () => {
    expect(REVIEW_RECHECK_EVERY).toBe(15);
  });

  it("default behaviour is unchanged: every call re-checks every review contact", async () => {
    const f = await setup();
    await runSendStep(f.deps());
    expect(f.track().filter((t) => t[21] === "review")).toHaveLength(5);
    const first = readsOf(f);
    await runSendStep(f.deps());
    expect(readsOf(f) - first).toBeGreaterThanOrEqual(15); // the 5 review contacts x 3 members, again
  });

  it("with a rotation of 5, each review contact is re-checked once per 5 calls and the good contacts are never delayed", async () => {
    const f = await setup();
    const first = await runSendStep(f.deps({ reviewRecheckEvery: 5 }));
    expect(first.sent).toBe(9); // the 3 good contacts went out at once
    const perCall: number[] = [];
    for (let call = 1; call <= 5; call++) {
      slot(f);
      const before = readsOf(f);
      await runSendStep(f.deps({ reviewRecheckEvery: 5 }));
      perCall.push(readsOf(f) - before);
    }
    expect(perCall.reduce((a, b) => a + b, 0)).toBe(15); // over 5 calls every review contact (5 x 3 drafts) is looked at exactly once...
    expect(Math.max(...perCall)).toBeLessThan(15); // ...never all of them in one call (the default would be 15 on every call)
    expect(f.gmail.sentMessages).toHaveLength(9);
  });

  it("newer eligible contacts are not starved by older review contacts: a call with little time reaches them first", async () => {
    /** The 3 good contacts' drafts only appear AFTER the 5 old contacts have been marked "review" (the situation in production: new work arrives behind old review work). */
    const scenario = async () => {
      const f = await setup();
      const late = new Map([...f.draftLedger].filter(([k]) => /conn_[567]:/.test(k)));
      for (const k of late.keys()) f.draftLedger.delete(k);
      await runSendStep(f.deps({ reviewRecheckEvery: 5 })); // marks the 5 old contacts "review"; the others still wait for their drafts
      expect(f.track().filter((t) => t[21] === "review")).toHaveLength(5);
      for (const [k, v] of late) f.draftLedger.set(k, v);
      slot(f);
      return f;
    };
    const withTime = (f: Awaited<ReturnType<typeof setup>>, over: Parameters<typeof f.deps>[0]) => {
      const start = readsOf(f);
      const deps = f.deps(over);
      Object.defineProperty(deps, "deadline", { get: () => (readsOf(f) - start >= 9 ? Date.now() - 1 : Date.now() + 60_000) }); // time for only 9 Gmail reads
      return deps;
    };
    const f = await scenario();
    expect((await runSendStep(withTime(f, { reviewRecheckEvery: 5 }))).sent).toBe(9);
    expect(f.gmail.sentMessages.every((m) => /^draft_[567]_/.test(m.draftId))).toBe(true);
    // Even without rotation the good contacts are reached first now: contacts whose open drafts are recorded as unsendable are evaluated last in every mode.
    const control = await scenario();
    expect((await runSendStep(withTime(control, {}))).sent).toBe(9);
  });

  it("a draft the member fixes while its contact is in review is sent within one rotation", async () => {
    const f = await setup();
    await runSendStep(f.deps({ reviewRecheckEvery: 5 }));
    const fixed = f.gmail.drafts.get("draft_2_anni") as { status: "ok"; draft: { attachments: unknown[] } };
    const good = f.gmail.drafts.get("draft_7_anni") as { status: "ok"; draft: { attachments: unknown[] } };
    f.gmail.drafts.set("draft_2_anni", { status: "ok", draft: { ...fixed.draft, attachments: good.draft.attachments } } as never);
    for (let call = 0; call < 5; call++) {
      slot(f);
      await runSendStep(f.deps({ reviewRecheckEvery: 5 }));
    }
    expect(f.gmail.sentMessages.some((m) => m.draftId === "draft_2_anni")).toBe(true);
  });
});

describe("contacts whose drafts are ALL recorded as unsendable (parked) are re-checked only occasionally, so they cannot use up every call", () => {
  const ALL = ["anni", "lukky", "rishii"] as const;
  /** 20 contacts whose lukky draft has no resume (so it is recorded as unsendable and every re-check costs a Gmail read) + 5 good ones. */
  async function setup() {
    const specs: ContactSpec[] = Array.from({ length: 25 }, (_, i) => ({ email: `p${i}@c${i}.example.com`, name: `Pat Person${i}`, company: `Co${i}`, members: [...ALL] }));
    const f = buildSendFixture(specs);
    for (let i = 0; i < 20; i++) {
      for (const m of ALL) {
        const d = f.gmail.drafts.get(`draft_${i}_${m}`) as { status: "ok"; draft: { attachments: unknown[] } };
        f.gmail.drafts.set(`draft_${i}_${m}`, { status: "ok", draft: { ...d.draft, attachments: [] } } as never); // no resume at all: every member's draft is unsendable
      }
    }
    await f.seed();
    return f;
  }
  const readsOf = (f: Awaited<ReturnType<typeof setup>>) => f.gmail.calls.filter((c) => c.startsWith("read:")).length;

  it("every call re-checks everything by default (unchanged behaviour)", async () => {
    const f = await setup();
    await runSendStep(f.deps());
    const first = readsOf(f);
    await runSendStep(f.deps());
    expect(readsOf(f) - first).toBeGreaterThan(20); // the 20 unsendable contacts (60 drafts) are looked at again
  });

  it("with a rotation of 5, each recorded-unsendable contact is re-checked once per 5 calls, and eligible drafts are never delayed", async () => {
    const f = await setup();
    const first = await runSendStep(f.deps({ reviewRecheckEvery: 5 }));
    expect(first.sent).toBe(15); // the 5 good contacts went out at once
    // Warm-up: recording WHY each draft is unsendable is bounded (25 notes per call), so the first calls still look at some contacts every time.
    for (let call = 0; call < 3; call++) {
      f.clock.now = new Date(f.clock.now.getTime() + 120_000);
      await runSendStep(f.deps({ reviewRecheckEvery: 5 }));
    }
    const perCall: number[] = [];
    for (let call = 1; call <= 5; call++) {
      f.clock.now = new Date(f.clock.now.getTime() + 120_000); // the next cron slot
      const before = readsOf(f);
      await runSendStep(f.deps({ reviewRecheckEvery: 5 }));
      perCall.push(readsOf(f) - before);
    }
    const total = perCall.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(55); // over 5 calls every contact (20 x 3 drafts) is re-checked about once...
    expect(total).toBeLessThanOrEqual(75);
    expect(Math.max(...perCall)).toBeLessThan(40); // ...but never all of them in one call (default would be 60 every call)
    expect(f.gmail.sentMessages).toHaveLength(15);
  });

  it("a newly eligible draft (the member fixed it) is sent within one rotation", async () => {
    const f = await setup();
    await runSendStep(f.deps({ reviewRecheckEvery: 5 }));
    const fixed = f.gmail.drafts.get("draft_3_anni") as { status: "ok"; draft: { attachments: unknown[] } };
    const good = f.gmail.drafts.get("draft_24_anni") as { status: "ok"; draft: { attachments: unknown[] } };
    f.gmail.drafts.set("draft_3_anni", { status: "ok", draft: { ...fixed.draft, attachments: good.draft.attachments } } as never);
    for (let call = 0; call < 5; call++) {
      f.clock.now = new Date(f.clock.now.getTime() + 120_000);
      await runSendStep(f.deps({ reviewRecheckEvery: 5 }));
    }
    expect(f.gmail.sentMessages.some((m) => m.draftId === "draft_3_anni")).toBe(true);
  });
});
