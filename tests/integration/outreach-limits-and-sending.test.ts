/**
 * The limits that remain and the ones that are gone:
 *   - IMPORT: 200 new Connections from the Outreach Database per rolling 24 h, GLOBAL; manual Connections never use it up.
 *   - SENDING: no JobSync cap (not per member, not combined, not per run). Only Gmail's own quotas and the safety checks slow it down.
 * Everything runs against in-memory fakes and a mock Gmail port: nothing real is contacted or sent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemberId } from "@/config/members";
import { classifySendResponse, type ReadResult } from "@/lib/gmail/send";
import { createConnection } from "@/lib/google-sheets/connections-service";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { runOutreachImport, type ImportDeps } from "@/lib/outreach/importer";
import { registerManualConnections } from "@/lib/outreach/manual";
import { realConnectionsPort } from "@/lib/outreach/run";
import { sendKeyFor } from "@/lib/outreach/send-ledger";
import { runSendStep } from "@/lib/outreach/send-workflow";
import { TRACKING_TAB, type SendRecord } from "@/lib/outreach/types";
import { createConnectionSchema } from "@/lib/validation/connections";
import { FakeSheets } from "../helpers/fake-sheets";
import { manyContacts, masterGrid, newOutreachSpreadsheet } from "../helpers/outreach";
import { NOW, buildSendFixture } from "../helpers/send-fixture";

const ALL: MemberId[] = ["anni", "lukky", "rishii"];
const people = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i}@c${prefix}${i}.example.com`, name: `Pat Person${i}`, company: `Co${i}`, members: ALL }));

// ---------------------------------------------------------------------------------------------------------------------------------
describe("1-2. the 200 import limit applies to Outreach Database imports only", () => {
  let prod: FakeSheets;
  let outreach: ReturnType<typeof newOutreachSpreadsheet>;
  let clock = new Date("2026-11-05T05:00:00.000Z");
  const deps = (over: Partial<ImportDeps> = {}): ImportDeps => ({ sheet: outreach.sheet, connections: realConnectionsPort, now: () => clock, timezone: "Asia/Kolkata", dailyLimit: 200, perRun: 50, ...over });
  const tracking = () => outreach.fake.dataRows(TRACKING_TAB).filter((r) => r[0]);
  const importedRows = () => tracking().filter((r) => r[2] === "outreach-database" && r[3] === "added");

  async function setup(master: string[][]) {
    prod = new FakeSheets().seedMembers();
    setSheetsClientForTesting(prod);
    resetMembersCache();
    invalidateTableCache();
    outreach = newOutreachSpreadsheet(masterGrid(master));
    await outreach.sheet.ensureTabs();
    clock = new Date("2026-11-05T05:00:00.000Z");
  }
  afterEach(() => setSheetsClientForTesting(null));

  const manual = async (n: number, owner: MemberId = "anni", offset = 0) => {
    for (let i = offset; i < offset + n; i++) {
      await createConnection(owner, createConnectionSchema.parse({ name: `Manual ${i}`, company: `ManCo${i}`, role: "Recruiter", email: `manual${i}@manco${i}.example.com`, status: "Not Connected" }), new Date(), { notify: false });
    }
  };
  const manualRows = () => tracking().filter((t) => t[2] === "manual" && t[3] === "added");

  it("at most 200 Connections are imported in a rolling 24 hours, ALL members together (not 200 each), however many are eligible", async () => {
    await setup(manyContacts(260));
    let guard = 0;
    while (guard++ < 12) if ((await runOutreachImport(deps())).stoppedBecause !== "run-limit") break;
    expect(importedRows()).toHaveLength(200);
    const last = await runOutreachImport(deps());
    expect(last).toMatchObject({ importedThisRun: 0, importedToday: 200, stoppedBecause: "daily-limit" });
    const byOwner = importedRows().reduce<Record<string, number>>((m, r) => ((m[r[5]] = (m[r[5]] ?? 0) + 1), m), {});
    expect(Object.values(byOwner).reduce((a, b) => a + b, 0)).toBe(200); // one pool of 200, shared out between the three owners
    expect(Math.max(...Object.values(byOwner))).toBeLessThan(200);
  });

  it("the window is rolling: after 24 hours the import continues with the next contacts", async () => {
    await setup(manyContacts(230));
    for (let i = 0; i < 6; i++) await runOutreachImport(deps());
    expect(importedRows()).toHaveLength(200);
    clock = new Date(clock.getTime() + 25 * 3600_000);
    for (let i = 0; i < 3; i++) await runOutreachImport(deps());
    expect(importedRows()).toHaveLength(230);
  }, 120_000);

  it("500 manually added Connections are all registered and are NOT blocked or counted by the import limit", async () => {
    await setup([]);
    await manual(500);
    const r = await registerManualConnections({ sheet: outreach.sheet, connections: realConnectionsPort, now: () => clock });
    expect(r.registered).toBeGreaterThanOrEqual(500); // the 500 added here (plus the few Connections the test workspace is seeded with)
    expect(manualRows()).toHaveLength(r.registered);
    expect(manualRows().length).toBeGreaterThan(200); // far past the import limit, none of it held back
  }, 120_000);

  it("manual Connections do not use up the import allowance: 500 manual + a full 200 imports still go through, and a later manual add is still registered", async () => {
    await setup(manyContacts(250));
    await manual(500);
    await registerManualConnections({ sheet: outreach.sheet, connections: realConnectionsPort, now: () => clock });
    let guard = 0;
    while (guard++ < 12) if ((await runOutreachImport(deps())).stoppedBecause !== "run-limit") break;
    expect(importedRows()).toHaveLength(200); // the full allowance was available despite 500 manual rows
    expect((await runOutreachImport(deps())).stoppedBecause).toBe("daily-limit");
    const manualBefore = manualRows().length;
    expect(manualBefore).toBeGreaterThanOrEqual(500);
    await manual(1, "lukky", 5000);
    const later = await registerManualConnections({ sheet: outreach.sheet, connections: realConnectionsPort, now: () => clock });
    expect(later.registered).toBe(1); // the import limit being reached does not stop manual Connections entering the workflow
    expect(manualRows()).toHaveLength(manualBefore + 1);
  }, 240_000);

  it("manual Connections bypass ONLY the import limit: an invalid e-mail is still skipped, and a duplicate of an existing person is not registered twice", async () => {
    await setup([]);
    await createConnection("anni", createConnectionSchema.parse({ name: "No Email", company: "X Co", role: "Recruiter", status: "Not Connected" }), new Date(), { notify: false });
    await manual(2);
    const r1 = await registerManualConnections({ sheet: outreach.sheet, connections: realConnectionsPort, now: () => clock });
    expect(r1.registered).toBeGreaterThanOrEqual(2);
    expect(r1.skipped).toBeGreaterThanOrEqual(1); // the one with no e-mail address is never registered
    const r2 = await registerManualConnections({ sheet: outreach.sheet, connections: realConnectionsPort, now: () => clock });
    expect(r2.registered).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("3. manual and imported Connections both produce three member-specific e-mails", () => {
  it("each Connection, whatever its source, is sent once from EACH member's own Gmail with that member's own draft and resume", async () => {
    const f = buildSendFixture(people(4));
    f.tracking[0].source = "manual";
    f.tracking[1].source = "manual";
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ sent: 12, errors: [] });
    for (let i = 0; i < 4; i++) {
      const mine = f.gmail.sentMessages.filter((m) => m.draftId.startsWith(`draft_${i}_`));
      expect(mine.map((m) => m.member).sort(), `connection ${i}`).toEqual(ALL);
      for (const m of mine) expect(m.draftId).toBe(`draft_${i}_${m.member}`); // a member only ever sends their OWN draft
    }
    expect(f.track().map((t) => t[2]).sort()).toEqual(["manual", "manual", "outreach-database", "outreach-database"]);
    expect(f.track().every((t) => t[21] === "sent")).toBe(true);
  });

  it("a manual Connection still goes through every eligibility check: an opted-out recipient is never sent to", async () => {
    const f = buildSendFixture(people(2));
    f.tracking[0].source = "manual";
    f.fake.tabs.set("Outreach Exclusions", [["Value", "Reason", "AddedAt", "AddedBy"], [people(2)[0].email, "asked not to be contacted", "", "anni"]]);
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(3); // only the second Connection
    expect(f.gmail.sentMessages.every((m) => m.draftId.startsWith("draft_1_"))).toBe(true);
    expect(f.track()[0][25]).toMatch(/\[not_excluded\].*asked not to be contacted/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("4. each member has their OWN allowance of 200 per rolling 24 h; there is no combined cap", () => {
  /** Rows of already-confirmed sends made within the last hour, as if the system had been sending all day. */
  async function seedSent(f: ReturnType<typeof buildSendFixture>, perMember: number | Partial<Record<(typeof ALL)[number], number>>, opts: { ageMs?: number; status?: SendRecord["status"] } = {}) {
    await f.sheet.ensureTabs();
    let { nextRow } = await f.sheet.readSendLedger();
    for (const member of ALL) {
      const n = typeof perMember === "number" ? perMember : (perMember[member] ?? 0);
      for (let i = 0; i < n; i++) {
        const at = new Date(NOW.getTime() - (opts.ageMs ?? 60_000 * (1 + (i % 50)))).toISOString();
        const rec: SendRecord = {
          row: 0, sendKey: sendKeyFor(member, `old${i}@old${i}.example.com`), contactId: `old${i}`, claimId: `old-${member}-${i}`, status: opts.status ?? "sent", member, gmailAccount: `${member}@gmail.test`, connectionId: `oldconn${i}`,
          company: "Old", role: "SDE", resumeFile: "r.pdf", resumeSha256: "0".repeat(64), resumeBytes: 10, draftId: `old_${member}_${i}`, threadId: "", gmailMessageId: `old-msg-${member}-${i}`, wordCount: 100, attempts: 1,
          notBefore: "", sentAt: at, sentDay: "2026-11-06", reason: "", history: "", createdAt: at, updatedAt: at,
        };
        await f.sheet.appendSendRecord(rec, nextRow++);
      }
    }
  }

  it("Anni at 200 waits, Lukky at 199 sends ONE more, Rishii (0) sends all of his: the members progress independently", async () => {
    const f = buildSendFixture(people(5));
    await seedSent(f, { anni: 200, lukky: 199, rishii: 0 });
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ sent: 6, errors: [] });
    expect(f.gmail.sentMessages.filter((x) => x.member === "anni")).toHaveLength(0);
    expect(f.gmail.sentMessages.filter((x) => x.member === "lukky")).toHaveLength(1);
    expect(f.gmail.sentMessages.filter((x) => x.member === "rishii")).toHaveLength(5);
    expect(r.waiting).toBeGreaterThanOrEqual(9); // Anni's 5 and Lukky's 4 wait for their window; nothing is parked or failed
    expect(r.failed).toBe(0);
  }, 240_000);

  it("600 combined is not a limit: with 199 each already sent, each member still sends one more", async () => {
    const f = buildSendFixture(people(2));
    await seedSent(f, 199);
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(3);
    for (const m of ALL) expect(f.gmail.sentMessages.filter((x) => x.member === m)).toHaveLength(1);
  }, 240_000);

  it("only CONFIRMED JobSync sends inside the rolling 24 h count: older sends and drafts sent by hand (sent_outside) do not use the allowance", async () => {
    const f = buildSendFixture(people(3));
    await seedSent(f, { anni: 250 }, { ageMs: 25 * 3_600_000 });
    await seedSent(f, { lukky: 250 }, { status: "sent_outside" });
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(9);
  }, 240_000);

  it("a single run is not capped either: 100 Connections -> 300 e-mails in one call, 100 from each member", async () => {
    const f = buildSendFixture(people(100));
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ sent: 300, stoppedBecause: "none" });
    for (const m of ALL) expect(f.gmail.sentMessages.filter((x) => x.member === m)).toHaveLength(100);
    expect(new Set(f.gmail.sentMessages.map((x) => x.draftId)).size).toBe(300); // each draft exactly once
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("5. genuine Gmail quotas and the existing sending safeguards are still respected", () => {
  const setup = async (n = 3) => {
    const f = buildSendFixture(people(n));
    await f.seed();
    return f;
  };

  it("Gmail's response codes are classified correctly: 429 / quota reasons = not sent, back off; a 2xx without the SENT label is NOT a confirmed send", () => {
    expect(classifySendResponse(429, {}, "60")).toMatchObject({ status: "rate_limited", retryAfterMs: 60_000 });
    for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded", "sendingLimitExceeded"]) {
      expect(classifySendResponse(403, { error: { errors: [{ reason }] } }), reason).toMatchObject({ status: "rate_limited" });
    }
    expect(classifySendResponse(403, { error: { errors: [{ reason: "forbidden" }] } })).toMatchObject({ status: "auth_failed" });
    expect(classifySendResponse(200, { id: "m1" })).toMatchObject({ status: "uncertain" }); // no SENT label: never claimed as sent
    expect(classifySendResponse(200, { id: "m1", labelIds: ["SENT"] })).toMatchObject({ status: "sent", messageId: "m1" });
    expect(classifySendResponse(503, {})).toMatchObject({ status: "uncertain" });
  });

  it("when Gmail refuses ONE member's account, only that account waits (no hammering); the other members keep sending", async () => {
    const f = await setup(3);
    f.gmail.sendScript = [{ status: "rate_limited" }]; // the very first send (anni's) is refused
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ sent: 6, failed: 1, stoppedBecause: "rate-limited" });
    expect(f.gmail.sentMessages.every((m) => m.member !== "anni")).toBe(true);
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:anni:"))).toHaveLength(1); // one refused attempt, then no more calls from that account
    expect((await runSendStep(f.deps())).sent).toBe(0); // still cooling down: nothing is attempted
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:anni:"))).toHaveLength(1);
    f.clock.now = new Date(NOW.getTime() + 16 * 60_000);
    expect((await runSendStep(f.deps())).sent).toBe(3); // cool-down over: anni's three e-mails go out
  });

  it("the back-off grows while Gmail keeps refusing the same account (15, 30, 60 minutes ...), and the cool-down survives across cron calls", async () => {
    const f = await setup(1);
    const waits: number[] = [];
    let t = NOW.getTime();
    for (let i = 0; i < 3; i++) {
      f.clock.now = new Date(t);
      f.gmail.sendScript = [{ status: "rate_limited" }];
      await runSendStep(f.deps());
      const newest = f.ledger().filter((r) => r[3] === "failed_transient").sort((a, b) => b[17].localeCompare(a[17]))[0];
      waits.push(Math.round((Date.parse(newest[17]) - t) / 60_000));
      t = Date.parse(newest[17]) + 60_000;
    }
    expect(waits).toEqual([15, 30, 60]);
  });

  it("Gmail's own refusals never push a recipient into manual review (they are pacing, not failures of that recipient)", async () => {
    const f = buildSendFixture([{ email: "solo@solo.example.com", name: "Sol Solo", company: "SoloCo", members: ["anni"] }]);
    await f.seed();
    for (let i = 0; i < 6; i++) {
      f.gmail.sendScript = [{ status: "rate_limited" }];
      f.clock.now = new Date(NOW.getTime() + i * 5 * 3600_000);
      await runSendStep(f.deps());
    }
    expect(f.track()[0][21]).not.toBe("review");
    f.clock.now = new Date(NOW.getTime() + 40 * 3600_000);
    f.gmail.sendScript = [];
    expect((await runSendStep(f.deps())).sent).toBe(1); // Gmail recovered: it goes out
    expect(f.ledger().filter((r) => r[3] === "sent")).toHaveLength(1);
  });

  it("a send is only ever recorded as sent after Gmail confirmed it (message id + SENT label); an unconfirmed result is not counted", async () => {
    const f = buildSendFixture([{ email: "solo@solo.example.com", name: "Sol Solo", company: "SoloCo", members: ["anni"] }]);
    await f.seed();
    f.gmail.sendScript = [{ status: "uncertain", reason: "2xx response without a SENT message id" }];
    f.gmail.reconcileScript = [{ state: "unknown", reason: "cannot tell" }];
    await runSendStep(f.deps());
    expect(f.ledger().filter((r) => r[3] === "sent")).toHaveLength(0);
    expect(f.ledger()[0][3]).toBe("uncertain");
  });

  it("the other safeguards are untouched: a recipient on the opt-out list, a bad address, or a draft whose content fails validation is not sent", async () => {
    const f = buildSendFixture([...people(3)]);
    f.tracking[0].email = "not-an-address";
    f.fake.tabs.set("Outreach Exclusions", [["Value", "Reason", "AddedAt", "AddedBy"], [people(3)[1].email, "opt out", "", "anni"]]);
    const good = f.gmail.drafts.get("draft_2_anni") as Extract<ReadResult, { status: "ok" }>;
    f.gmail.drafts.set("draft_2_anni", { status: "ok", draft: { ...good.draft, body: "Hi,\nShort and wrong." } });
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(2);
    // Connection 1 (bad address) and 2 (opted out) send nothing; on Connection 3 anni's invalid draft is held, the other two members' drafts go out
    expect(f.gmail.sentMessages.map((m) => m.draftId).sort()).toEqual(["draft_2_lukky", "draft_2_rishii"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("13. recipient de-duplication still works independently for each member", () => {
  it("a member who already e-mailed this recipient sends nothing more to them; the other members still send theirs", async () => {
    const f = buildSendFixture(people(2));
    await f.seed();
    await f.sheet.ensureTabs();
    const { nextRow } = await f.sheet.readSendLedger();
    const at = new Date(NOW.getTime() - 3600_000).toISOString();
    await f.sheet.appendSendRecord({
      row: 0, sendKey: sendKeyFor("lukky", people(2)[0].email), contactId: "x", claimId: "earlier", status: "sent", member: "lukky", gmailAccount: "lakshya@gmail.test", connectionId: "other", company: "Co0", role: "SDE", resumeFile: "r.pdf",
      resumeSha256: "0".repeat(64), resumeBytes: 10, draftId: "earlier_draft", threadId: "", gmailMessageId: "earlier-msg", wordCount: 100, attempts: 1, notBefore: "", sentAt: at, sentDay: "2026-11-06", reason: "", history: "", createdAt: at, updatedAt: at,
    }, nextRow);
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(5); // Connection 0: anni + rishii (lukky already did); Connection 1: all three
    expect(f.gmail.sentMessages.filter((m) => m.member === "lukky" && m.draftId === "draft_0_lukky")).toHaveLength(0);
    expect(r.duplicatesPrevented).toBeGreaterThanOrEqual(1);
  });

  it("the same person on two Connections (e.g. one manual, one imported) gets exactly one e-mail from each member, not two", async () => {
    const f = buildSendFixture([{ email: "dup@acme.example.com", name: "Dee Dup", company: "Acme", members: ALL }, { email: "DUP@Acme.Example.com", name: "Dee Dup", company: "Acme", members: ALL }]);
    f.tracking[1].source = "manual";
    await f.seed();
    await runSendStep(f.deps());
    await runSendStep(f.deps());
    expect(f.gmail.sentMessages).toHaveLength(3);
    expect(f.gmail.sentMessages.map((m) => m.member).sort()).toEqual(ALL);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("12 / 14. uncertain sends are never resent; concurrent and interrupted runs stay safe", () => {
  it("an uncertain send that cannot be proven stays unresolved across many cron calls and is never sent a second time; everything else still sends", async () => {
    const f = buildSendFixture(people(3));
    await f.seed();
    f.gmail.sendScript = [{ status: "uncertain", reason: "timeout" }];
    f.gmail.reconcileScript = [{ state: "unknown", reason: "metadata permission missing" }];
    const first = await runSendStep(f.deps());
    expect(first.sent).toBe(8);
    for (let day = 1; day <= 5; day++) {
      f.clock.now = new Date(NOW.getTime() + day * 24 * 3600_000);
      f.gmail.reconcileScript = [{ state: "unknown", reason: "still unknown" }];
      await runSendStep(f.deps());
    }
    const uncertainKey = f.ledger().find((r) => r[3] === "uncertain")![0];
    expect(f.ledger().filter((r) => r[0] === uncertainKey)).toHaveLength(1); // no second claim, no second send for that member and recipient
    expect(f.gmail.sendCalls()).toHaveLength(9); // 9 sends attempted in total: the uncertain one exactly once
    expect(f.ledger().filter((r) => r[3] === "sent")).toHaveLength(8);
  });

  it("an interrupted run (crash right after 'sending') is reconciled against Gmail before anything else; the crashed send is not repeated", async () => {
    const f = buildSendFixture(people(3));
    await f.seed();
    f.gmail.sendScript = ["throw"]; // the process dies inside the first Gmail call
    const crashed = await runSendStep(f.deps());
    expect(crashed.stoppedBecause).toBe("error");
    expect(f.ledger().map((r) => r[3])).toEqual(["sending"]);
    // a run right afterwards (e.g. an overlapping cron call) must not touch that key
    await runSendStep(f.deps());
    expect(f.gmail.sendCalls().filter((c) => c === "send:anni:draft_0_anni")).toHaveLength(1);
    // later: Gmail proves it WAS sent -> recorded once from Gmail's own message id, and the rest continues
    f.clock.now = new Date(NOW.getTime() + 3 * 60_000);
    f.gmail.reconcileScript = [{ state: "sent", messageId: "msg-proved" }];
    const resumed = await runSendStep(f.deps());
    expect(resumed.reconciled).toBeGreaterThanOrEqual(1);
    const row = f.ledger().find((r) => r[0] === sendKeyFor("anni", people(3)[0].email))!;
    expect(row[3]).toBe("sent");
    expect(row[14]).toBe("msg-proved");
    expect(f.gmail.sendCalls()).toHaveLength(9); // 9 attempts for 9 e-mails: nothing was ever sent twice
    expect(new Set(f.gmail.sendCalls()).size).toBe(9);
  });

  it("concurrent workers (overlapping cron calls) never send the same member's e-mail to the same recipient twice, across many Connections", async () => {
    const f = buildSendFixture(people(12));
    await f.seed();
    await Promise.all([runSendStep(f.deps()), runSendStep(f.deps()), runSendStep(f.deps()), runSendStep(f.deps())]);
    const sent = f.ledger().filter((r) => r[3] === "sent");
    expect(new Set(sent.map((r) => r[0])).size).toBe(sent.length);
    expect(new Set(f.gmail.sendCalls()).size).toBe(f.gmail.sendCalls().length);
    // and whatever the overlapping calls left undone is completed by later calls, still without duplicates
    await runSendStep(f.deps());
    await runSendStep(f.deps());
    expect(f.ledger().filter((r) => r[3] === "sent")).toHaveLength(36);
    expect(new Set(f.gmail.sendCalls()).size).toBe(36);
  }, 120_000);
});

beforeEach(() => undefined);
