/**
 * Stale drafts and Gmail reconciliation (the 11 Nov 2026 finding): Lukky's drafts had been SENT outside JobSync, Gmail kept resolving their ids, the
 * sender passed its readback, drafts.send answered "Message not a draft" and the generic-400 handling recorded permanent failures that also used up
 * the whole send time slice.
 *
 * Everything runs against in-memory spreadsheets and a MOCK Gmail port: nothing real is contacted and no e-mail is sent.
 */
import { describe, expect, it } from "vitest";
import type { MemberId } from "@/config/members";
import { runSendStep } from "@/lib/outreach/send-workflow";
import { claimSend } from "@/lib/outreach/send-ledger";
import { sendKeyFor } from "@/lib/outreach/send-ledger";
import { createDraftPresence, type MemberDrafts } from "@/lib/gmail/draft-backlog";
import type { SendRecord } from "@/lib/outreach/types";
import { NOW, buildSendFixture, resumeFile } from "../helpers/send-fixture";

const ALL: MemberId[] = ["anni", "lukky", "rishii"];
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `p${i}@cp${i}.example.com`, name: `Pat Person${i}`, company: `Co${i}`, members: ALL }));
const draftOf = (i: number, m: MemberId) => `draft_${i}_${m}`;
// Send Ledger columns (see SEND_LEDGER_HEADERS)
const STATUS = 3, MEMBER = 4, ACCOUNT = 5, RESUME = 9, DRAFT = 12, MSGID = 14, REASON = 20;
const OUTSIDE = /already sent outside JobSync/;

describe("A. a draft that was already sent by hand (Gmail still resolves the id, the message is labelled SENT)", () => {
  it("is never sent, never claimed, never counted as ours; it is parked with the reason; the other members' e-mails for the same contact go out in the same call", async () => {
    const f = buildSendFixture(people(3));
    await f.seed();
    for (let i = 0; i < 3; i++) f.gmail.markSentOutside(draftOf(i, "lukky")); // Lukky bulk-sent all his drafts by hand
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(6); // Anni 3 + Rishii 3
    expect(r.externallySent).toBe(3);
    expect(f.gmail.sendCalls().some((c) => c.startsWith("send:lukky"))).toBe(false); // drafts.send is NEVER called for them
    expect(f.ledger().filter((x) => x[MEMBER] === "lukky")).toHaveLength(0); // no claim, no ledger row at all
    expect(f.ledger().filter((x) => x[STATUS] === "sent").every((x) => x[MEMBER] !== "lukky")).toBe(true);
    expect(f.calls.parked.filter((p) => p.startsWith("lukky:") && OUTSIDE.test(p))).toHaveLength(3); // parked with a clear reason
    expect(f.calls.markSent.some((c) => c.startsWith("lukky:"))).toBe(false); // the draft ledger is not marked "sent by us"
  });

  it("costs nothing on later calls beyond the label check: still no send, and Anni/Rishii keep going", async () => {
    const f = buildSendFixture(people(4));
    await f.seed();
    for (let i = 0; i < 4; i++) f.gmail.markSentOutside(draftOf(i, "lukky"));
    await runSendStep(f.deps());
    f.clock.now = new Date(NOW.getTime() + 3 * 60_000);
    const again = await runSendStep(f.deps());
    expect(again.sent).toBe(0);
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:lukky"))).toHaveLength(0);
    expect(f.ledger().filter((x) => x[STATUS] === "sent")).toHaveLength(8);
  });

  it("a message with no DRAFT label (e.g. trashed) is not sent either; Gmail reporting NO labels at all means 'cannot tell': nothing is sent until it does", async () => {
    const f = buildSendFixture(people(2));
    await f.seed();
    const trash = f.gmail.drafts.get(draftOf(0, "anni"));
    if (trash?.status === "ok") f.gmail.drafts.set(draftOf(0, "anni"), { status: "ok", draft: { ...trash.draft, labelIds: ["TRASH"] } });
    const bare = f.gmail.drafts.get(draftOf(1, "rishii"));
    if (bare?.status === "ok") { const { labelIds: _drop, ...rest } = bare.draft; void _drop; f.gmail.drafts.set(draftOf(1, "rishii"), { status: "ok", draft: rest }); }
    const r = await runSendStep(f.deps());
    expect(f.gmail.sendCalls()).not.toContain(`send:anni:${draftOf(0, "anni")}`);
    expect(f.gmail.sendCalls()).not.toContain(`send:rishii:${draftOf(1, "rishii")}`);
    expect(r.staleSkipped).toBe(1); // the trashed one
    expect(r.waiting).toBeGreaterThanOrEqual(1); // the label-less one waits
    expect(f.ledger().filter((x) => x[DRAFT] === draftOf(1, "rishii") || x[DRAFT] === draftOf(0, "anni"))).toHaveLength(0);
    expect(f.gmail.sendCalls()).toHaveLength(4); // the other four e-mails went out
  });
});

describe("B. a draft the member deleted by hand", () => {
  it("is not sent (Gmail 404), leaves no claim, and the rest of the queue is processed", async () => {
    const f = buildSendFixture(people(3));
    await f.seed();
    f.gmail.deleteDraft(draftOf(0, "lukky"));
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(8);
    expect(f.gmail.sendCalls()).not.toContain(`send:lukky:${draftOf(0, "lukky")}`);
    expect(f.ledger().filter((x) => x[DRAFT] === draftOf(0, "lukky"))).toHaveLength(0);
  });
});

describe("C. a draft that is genuinely still pending", () => {
  it("is sent exactly once from its own member's Gmail with that member's own resume, and counted as a normal automated send", async () => {
    const f = buildSendFixture(people(2));
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(6);
    expect(r.externallySent ?? 0).toBe(0);
    for (const m of ALL) {
      const mine = f.ledger().filter((x) => x[MEMBER] === m && x[STATUS] === "sent");
      expect(mine).toHaveLength(2);
      expect(mine.every((x) => x[ACCOUNT] === f.gmail.addresses[m] && x[RESUME] === resumeFile(m) && x[MSGID] !== "")).toBe(true);
    }
    expect(new Set(f.gmail.sendCalls()).size).toBe(6);
  });
});

describe("D. Gmail answers 'Message not a draft' to drafts.send (the id looked fine a moment ago)", () => {
  it("when Gmail's own state proves the message is SENT: recorded as sent_outside (new row), NOT counted as ours, parked, never retried, and the next member goes on", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    // Anni sends normally; Lukky's send is refused as "not a draft" (race: it was sent between the readback and the send); Rishii sends normally
    f.gmail.refuseAsNotADraftFor.add("lukky");
    f.gmail.inspectScript = [{ state: "sent_outside", messageId: "msg-by-hand" }];
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(2); // Anni + Rishii
    expect(r.externallySent).toBe(1);
    const row = f.ledger().find((x) => x[MEMBER] === "lukky")!;
    expect(row[STATUS]).toBe("sent_outside");
    expect(row[MSGID]).toBe(""); // never stored where a reader that looks only at the message id could mistake it for a send
    expect(row[REASON]).toMatch(OUTSIDE);
    expect(row[REASON]).toContain("msg-by-hand");
    expect(f.ledger().filter((x) => x[STATUS] === "failed_permanent")).toHaveLength(0); // NOT the old generic-400 handling
    expect(f.calls.markSent.some((c) => c.startsWith("lukky:"))).toBe(false);
    expect(f.calls.parked.some((p) => p.startsWith("lukky:") && OUTSIDE.test(p))).toBe(true);
    // never retried, however many later calls
    for (let k = 1; k <= 3; k++) { f.clock.now = new Date(NOW.getTime() + k * 3 * 60_000); await runSendStep(f.deps()); }
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:lukky"))).toHaveLength(1);
    expect(f.ledger().filter((x) => x[MEMBER] === "lukky")).toHaveLength(1);
    expect(f.ledger().filter((x) => x[STATUS] === "sent")).toHaveLength(2);
  });

  for (const [name, answer] of [
    ["the message is still labelled DRAFT (contradiction)", { state: "pending_draft" }],
    ["Gmail cannot say (unknown)", { state: "unknown", reason: "Gmail answered 503" }],
    ["the inspection itself throws", "throw"],
  ] as const) {
    it(`when ${name}: left for review (needs_review), never assumed sent or deleted, never retried`, async () => {
      const f = buildSendFixture(people(1));
      await f.seed();
      f.gmail.refuseAsNotADraftFor.add("lukky");
      f.gmail.inspectScript = [answer as never];
      const r = await runSendStep(f.deps());
      expect(r.sent).toBe(2);
      expect(r.externallySent ?? 0).toBe(0);
      expect(f.ledger().find((x) => x[MEMBER] === "lukky")![STATUS]).toBe("needs_review");
      for (let k = 1; k <= 3; k++) { f.clock.now = new Date(NOW.getTime() + k * 3 * 60_000); await runSendStep(f.deps()); }
      expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:lukky"))).toHaveLength(1);
    });
  }

  it("a generic 400 is still a permanent rejection (only the specific refusal changed)", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    f.gmail.sendScript = [{ status: "rejected", reason: "Invalid To header" }];
    await runSendStep(f.deps());
    expect(f.ledger().filter((x) => x[STATUS] === "failed_permanent")).toHaveLength(1);
  });
});

describe("E. uncertain sends are reconciled against Gmail, never retried blindly", () => {
  it("proved SENT after the attempt began -> recorded as OUR send (counted once)", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    f.gmail.sendScript = [{ status: "uncertain", reason: "timeout" }];
    f.gmail.reconcileScript = [{ state: "sent", messageId: "msg-proved" }];
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(3);
    expect(f.ledger().find((x) => x[MSGID] === "msg-proved")![STATUS]).toBe("sent");
    expect(f.gmail.sendCalls()).toHaveLength(3);
  });
  it("proved SENT BEFORE the attempt began -> sent_outside: not counted as ours, parked, not retried", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    f.gmail.sendScript = [{ status: "uncertain", reason: "timeout" }];
    f.gmail.reconcileScript = [{ state: "external", reason: "the message was sent before this attempt began, so it was sent outside JobSync" }];
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(2);
    expect(r.externallySent).toBe(1);
    expect(f.ledger().filter((x) => x[STATUS] === "sent_outside")).toHaveLength(1);
    for (let k = 1; k <= 3; k++) { f.clock.now = new Date(NOW.getTime() + k * 3 * 60_000); await runSendStep(f.deps()); }
    expect(f.gmail.sendCalls()).toHaveLength(3); // the uncertain one exactly once
  });
  it("cannot be proven (Gmail down / no labels) -> stays uncertain for a person; never resent, however many calls", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    f.gmail.sendScript = [{ status: "uncertain", reason: "timeout" }];
    f.gmail.reconcileScript = [{ state: "unknown", reason: "Gmail answered 503" }];
    await runSendStep(f.deps());
    for (let k = 1; k <= 4; k++) { f.clock.now = new Date(NOW.getTime() + k * 24 * 3600_000); f.gmail.reconcileScript = [{ state: "unknown", reason: "still unknown" }]; await runSendStep(f.deps()); }
    expect(f.ledger().filter((x) => x[STATUS] === "uncertain")).toHaveLength(1);
    expect(f.gmail.sendCalls()).toHaveLength(3);
  });
});

describe("F. Gmail unavailable or rate-limited: fail safe, nothing assumed", () => {
  it("an unreadable draft (Gmail error) waits; nothing is claimed or sent for it; other members continue", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    const original = f.gmail.readDraft.bind(f.gmail);
    f.gmail.readDraft = async (m, id) => (m === "lukky" ? { status: "error" as const, reason: "Gmail error 503" } : original(m, id));
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(2);
    expect(r.waiting).toBeGreaterThanOrEqual(1);
    expect(f.ledger().filter((x) => x[MEMBER] === "lukky")).toHaveLength(0);
  });
  it("a rate-limited send backs that member off (nothing sent, nothing parked as external); the others continue", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    f.gmail.sendScript = [{ status: "rate_limited", retryAfterMs: 60_000 }]; // Anni's
    const r = await runSendStep(f.deps());
    expect(r.externallySent ?? 0).toBe(0);
    expect(f.ledger().filter((x) => x[STATUS] === "failed_transient")).toHaveLength(1);
    expect(r.sent).toBe(2);
  });
  it("the cached drafts.list failing ('unknown') or throwing never skips anything: the fully verified path runs and the draft is sent", async () => {
    for (const presence of [{ has: async () => "unknown" as const }, { has: async (): Promise<"unknown"> => { throw new Error("list failed"); } }]) {
      const f = buildSendFixture(people(1));
      await f.seed();
      const r = await runSendStep(f.deps({ presence }));
      expect(r.sent).toBe(3);
      expect(r.staleSkipped ?? 0).toBe(0);
    }
  });
});

describe("G. the cached drafts.list skips stale ledger drafts cheaply", () => {
  it("a draft absent from the member's real Drafts is skipped with NO per-draft Gmail call and NO claim, parked, and the next draft is processed", async () => {
    const f = buildSendFixture(people(3));
    await f.seed();
    const gone = new Set(["lukky"]);
    const r = await runSendStep(f.deps({ presence: { has: async (m) => (gone.has(m) ? "absent" : "present") } }));
    expect(r.sent).toBe(6);
    expect(r.staleSkipped).toBe(3);
    expect(f.gmail.calls.filter((c) => c.startsWith("read:lukky") || c.startsWith("send:lukky"))).toHaveLength(0); // not even a readback
    expect(f.ledger().filter((x) => x[MEMBER] === "lukky")).toHaveLength(0);
    expect(f.calls.parked.filter((p) => p.startsWith("lukky:"))).toHaveLength(3);
  });
  it("the production presence check (real listing code) answers absent only for a complete successful listing", async () => {
    let listing: MemberDrafts = { status: "ok", ids: new Set(["d1"]) };
    let t = 0;
    const p = createDraftPresence({ list: async () => listing, ttlMs: 1000, now: () => t });
    expect(await p.has("lukky", "d1")).toBe("present");
    expect(await p.has("lukky", "d2")).toBe("absent");
    listing = { status: "unavailable", reason: "Gmail answered 500" };
    t = 5000;
    expect(await p.has("lukky", "d2")).toBe("unknown"); // failure => never "absent"
    listing = { status: "not_connected" };
    t = 20_000;
    expect(await p.has("lukky", "d2")).toBe("unknown");
    const boom = createDraftPresence({ list: async () => { throw new Error("net"); } });
    expect(await boom.has("anni", "d1")).toBe("unknown");
  });
  it("the listing is reused within its lifetime (one call per member), shared by concurrent callers, and a failure is not cached as success", async () => {
    let calls = 0;
    let t = 0;
    const p = createDraftPresence({ list: async () => { calls += 1; return { status: "ok", ids: new Set(["a"]) }; }, ttlMs: 1000, now: () => t });
    await Promise.all([p.has("anni", "a"), p.has("anni", "b"), p.has("anni", "a")]);
    await p.has("anni", "a");
    expect(calls).toBe(1);
    t = 2000;
    await p.has("anni", "a");
    expect(calls).toBe(2);
    p.invalidate();
    await p.has("anni", "a");
    expect(calls).toBe(3);
  });
});

describe("H. fairness: one member's stale drafts cannot starve the others", () => {
  it("with ALL of Lukky's drafts stale (his folder is empty), Anni and Rishii still send for every contact in a single call and Lukky costs no sends or claims", async () => {
    const f = buildSendFixture(people(30));
    await f.seed();
    for (let i = 0; i < 30; i++) f.gmail.markSentOutside(draftOf(i, "lukky"));
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(60);
    expect(f.ledger().filter((x) => x[MEMBER] === "anni" && x[STATUS] === "sent")).toHaveLength(30);
    expect(f.ledger().filter((x) => x[MEMBER] === "rishii" && x[STATUS] === "sent")).toHaveLength(30);
    expect(f.ledger().filter((x) => x[MEMBER] === "lukky")).toHaveLength(0);
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:lukky"))).toHaveLength(0);
    // no contact is marked fully sent: Lukky's e-mail was not sent by us
    expect(f.track().some((t) => t[21] === "sent")).toBe(false);
  }, 120_000);
});

describe("I. concurrent runs and duplicate protection", () => {
  it("overlapping workers never send a stale draft and never send anything twice", async () => {
    const f = buildSendFixture(people(10));
    await f.seed();
    for (let i = 0; i < 10; i++) f.gmail.markSentOutside(draftOf(i, "lukky"));
    await Promise.all([runSendStep(f.deps()), runSendStep(f.deps()), runSendStep(f.deps()), runSendStep(f.deps())]);
    await runSendStep(f.deps());
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:lukky"))).toHaveLength(0);
    expect(new Set(f.gmail.sendCalls()).size).toBe(f.gmail.sendCalls().length);
    expect(f.ledger().filter((x) => x[STATUS] === "sent")).toHaveLength(20);
  }, 120_000);
  it("a refused 'not a draft' attempt that races with another worker is still recorded once", async () => {
    const f = buildSendFixture(people(2));
    await f.seed();
    f.gmail.refuseAsNotADraftFor.add("lukky");
    f.gmail.inspectScript = Array.from({ length: 8 }, () => ({ state: "sent_outside" as const, messageId: "m-x" }));
    await Promise.all([runSendStep(f.deps()), runSendStep(f.deps()), runSendStep(f.deps())]);
    const lukky = f.ledger().filter((x) => x[MEMBER] === "lukky" && x[STATUS] !== "superseded"); // a worker that loses the claim race leaves an inert "superseded" row (existing behaviour)
    expect(new Set(lukky.map((x) => x[0])).size).toBe(lukky.length); // exactly one effective row per recipient
    expect(lukky.every((x) => x[STATUS] === "sent_outside")).toBe(true);
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:lukky")).length).toBeLessThanOrEqual(2);
  }, 120_000);
});

describe("J. history is preserved and the sent_outside status blocks claims", () => {
  it("an existing failed_permanent row (like the six Lukky ones) is never rewritten, never retried, and costs no Gmail call", async () => {
    const f = buildSendFixture(people(2));
    await f.seed();
    const t0 = (await f.sheet.readTracking()).records[0];
    const before = await claimSend(f.sheet, { sendKey: sendKeyFor("lukky", t0.email), contactId: t0.contactId, member: "lukky", gmailAccount: "lakshya@gmail.test", connectionId: t0.connectionId, company: "Co0", role: "SDE", draftId: draftOf(0, "lukky"), threadId: "thr", resumeFile: resumeFile("lukky"), resumeSha256: "x", resumeBytes: 10, wordCount: 100 }, "2026-11-06", NOW);
    if (!before.won) throw new Error("setup");
    await f.sheet.updateSendRecord({ ...before.record, status: "failed_permanent", reason: "Message not a draft", updatedAt: NOW.toISOString() } as SendRecord);
    f.gmail.markSentOutside(draftOf(0, "lukky"));
    const snapshot = JSON.stringify(f.ledger().find((x) => x[MEMBER] === "lukky"));
    await runSendStep(f.deps());
    await runSendStep(f.deps());
    expect(JSON.stringify(f.ledger().find((x) => x[MEMBER] === "lukky" && x[DRAFT] === draftOf(0, "lukky")))).toBe(snapshot); // byte-for-byte unchanged
    expect(f.gmail.sendCalls().filter((c) => c === `send:lukky:${draftOf(0, "lukky")}`)).toHaveLength(0);
  });
  it("claimSend refuses a recipient that already has a sent_outside row", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    const t0 = (await f.sheet.readTracking()).records[0];
    const input = { sendKey: sendKeyFor("lukky", t0.email), contactId: t0.contactId, member: "lukky", gmailAccount: "lakshya@gmail.test", connectionId: t0.connectionId, company: "Co0", role: "SDE", draftId: draftOf(0, "lukky"), threadId: "thr", resumeFile: resumeFile("lukky"), resumeSha256: "x", resumeBytes: 10, wordCount: 100 };
    const first = await claimSend(f.sheet, input, "2026-11-06", NOW);
    if (!first.won) throw new Error("setup");
    await f.sheet.updateSendRecord({ ...first.record, status: "sent_outside", gmailMessageId: "m-x", reason: "already sent outside JobSync", updatedAt: NOW.toISOString() } as SendRecord);
    const second = await claimSend(f.sheet, input, "2026-11-06", new Date(NOW.getTime() + 3600_000));
    expect(second).toMatchObject({ won: false, reason: "sent_outside" });
  });
});

// =====================================================================================================================================================
// Review pass: sent_outside compatibility, the final pre-send check, attempt-start attribution, parking and production compatibility.
// =====================================================================================================================================================
import { attemptStartOf } from "@/lib/outreach/send-workflow";
import { confirmedSendCount } from "@/lib/outreach/announce";
import { computeCounters } from "@/lib/outreach/sync";
import { parseSendRecord, serializeSendRecord } from "@/lib/outreach/sheet";

describe("K. the final label check happens right before drafts.send, whatever the cached listing said", () => {
  it("listing says PRESENT and the readback says DRAFT, but the message was sent a moment later: the final check stops the send (no drafts.send, no 'sending' state)", async () => {
    const f = buildSendFixture(people(2));
    await f.seed();
    // Lukky sends contact 0's draft by hand right after JobSync has read it back (the world changes between the readback and the send)
    f.gmail.onRead = (m, id) => { if (m === "lukky" && id === draftOf(0, "lukky")) f.gmail.markSentOutside(id); };
    const r = await runSendStep(f.deps({ presence: { has: async () => "present" } }));
    expect(f.gmail.sendCalls()).not.toContain(`send:lukky:${draftOf(0, "lukky")}`);
    const row = f.ledger().find((x) => x[DRAFT] === draftOf(0, "lukky"))!;
    expect(row[STATUS]).toBe("sent_outside");
    expect(row[MSGID]).toBe("");
    expect(row[REASON]).toMatch(OUTSIDE);
    expect(r.externallySent).toBe(1);
    expect(String(row[21])).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}Z sending(;|$)/); // its history never contains a "sending" event: the Gmail request was never made
    expect(r.sent).toBe(5); // everything else went out: Anni 2, Rishii 2, Lukky's contact 1
  });

  it("the order for every send is: readback, then (after the claim) the final check, then drafts.send", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    await runSendStep(f.deps());
    for (const m of ALL) {
      const id = draftOf(0, m);
      const calls = f.gmail.calls;
      expect(calls.indexOf(`read:${m}:${id}`)).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf(`inspect:${m}:${id}`)).toBeGreaterThan(calls.indexOf(`read:${m}:${id}`));
      expect(calls.indexOf(`send:${m}:${id}`)).toBeGreaterThan(calls.indexOf(`inspect:${m}:${id}`));
    }
  });

  it("when the final check cannot reach Gmail, NOTHING is sent and the claim is released (safe to retry): never assumed to be a draft, sent or deleted", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    f.gmail.inspectDown = true;
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(0);
    expect(f.gmail.sendCalls()).toHaveLength(0);
    expect(f.ledger().every((x) => x[STATUS] === "released")).toBe(true);
    expect(f.ledger().every((x) => /nothing was sent/.test(String(x[REASON])))).toBe(true);
    f.gmail.inspectDown = false; // Gmail is back: the same drafts are sent, once each
    f.clock.now = new Date(NOW.getTime() + 3 * 60_000);
    expect((await runSendStep(f.deps())).sent).toBe(3);
    expect(new Set(f.gmail.sendCalls()).size).toBe(3);
  });
});

describe("L. the attempt start used to attribute a SENT message is the moment the Gmail request began", () => {
  it("is taken after the claim, the final check and the 'sending' write, NOT at the start of the run (which is what the claim row's CreatedAt holds)", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    let advanced = false;
    f.gmail.onInspect = () => { if (!advanced) { advanced = true; f.clock.now = new Date(NOW.getTime() + 7_000); } }; // 7 s pass between the claim and the send
    f.gmail.sendScript = [{ status: "uncertain", reason: "timeout" }];
    f.gmail.reconcileScript = [{ state: "unknown", reason: "Gmail answered 503" }];
    await runSendStep(f.deps());
    expect(f.gmail.reconcileSince[0]).toBe(NOW.getTime() + 7_000);
    expect(f.gmail.reconcileSince[0]).not.toBe(NOW.getTime());
    const row = f.ledger().find((x) => x[STATUS] === "uncertain")!;
    expect(Date.parse(String(row[22]))).toBe(NOW.getTime()); // CreatedAt = run start: it must NOT be used as the attempt start
  });

  it("a later run reconciling an interrupted attempt uses the 'sending' time from the row's own history", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    f.gmail.sendScript = ["throw"]; // crash right after 'sending' was written
    await runSendStep(f.deps());
    f.clock.now = new Date(NOW.getTime() + 3 * 60_000);
    f.gmail.reconcileScript = [{ state: "unknown", reason: "still unknown" }];
    await runSendStep(f.deps());
    expect(f.gmail.reconcileSince).toContain(NOW.getTime());
    expect(f.gmail.reconcileSince.every((s) => s !== undefined)).toBe(true);
  });

  it("attemptStartOf reads the LAST 'sending' event of the history, survives truncation, and is undefined when there is none (then nothing can be attributed)", () => {
    expect(attemptStartOf("2026-11-11T19:27:10.503Z claimed (attempt 1); 2026-11-11T19:27:21.768Z sending; 2026-11-11T19:27:23.200Z uncertain send result; reconciling")).toBe(Date.parse("2026-11-11T19:27:21.768Z"));
    expect(attemptStartOf("2026-11-11T10:00:00.000Z sending; 2026-11-11T10:20:00.000Z released; 2026-11-11T11:00:00.000Z sending")).toBe(Date.parse("2026-11-11T11:00:00.000Z"));
    expect(attemptStartOf("…ed (attempt 2); 2026-11-11T19:27:21.768Z sending")).toBe(Date.parse("2026-11-11T19:27:21.768Z"));
    expect(attemptStartOf("2026-11-11T19:27:10.503Z claimed (attempt 1)")).toBeUndefined();
    expect(attemptStartOf("")).toBeUndefined();
    expect(attemptStartOf("2026-11-11T19:27:21.768Z sending now")).toBeUndefined(); // not the exact event
  });
});

describe("M. sent_outside is never mistaken for sent, sending or a retryable failure", () => {
  const withStatus = async (status: SendRecord["status"], extra: Partial<SendRecord> = {}) => {
    const f = buildSendFixture(people(1));
    await f.seed();
    await runSendStep(f.deps());
    const base = (await f.sheet.readSendLedger()).records.find((r) => r.member === "anni")!;
    return { f, rec: { ...base, status, ...extra } as SendRecord };
  };
  it("counters, the 'N emails sent' milestone and the failure count ignore it, EVEN IF a message id were present on the row", async () => {
    const { f, rec } = await withStatus("sent_outside", { gmailMessageId: "msg-123" });
    const tracking = (await f.sheet.readTracking()).records;
    const only = [rec];
    expect(confirmedSendCount(only)).toBe(0);
    const c = computeCounters(tracking, "2026-11-06", 0, { ledger: only });
    expect(c.emailsSent).toBe(0);
    expect(c.sentToday).toBe(0);
    expect(c.failedSends).toBe(0); // not a failure either
    expect(confirmedSendCount([{ ...rec, status: "sent" }])).toBe(1); // the same row as a real send IS counted: the status is the filter
  });
  it("is never a retryable failure, never in flight, and never reconciled again", async () => {
    const { f, rec } = await withStatus("sent_outside");
    const { countedFailures, ACTIVE, BLOCKING } = await import("@/lib/outreach/send-ledger");
    expect(countedFailures([rec])).toBe(0);
    expect(ACTIVE).not.toContain("sent_outside");
    expect(BLOCKING).not.toContain("sent_outside");
    await f.sheet.updateSendRecord({ ...rec, updatedAt: "2026-01-01T00:00:00.000Z" });
    f.clock.now = new Date(NOW.getTime() + 24 * 3600_000);
    const before = f.gmail.calls.filter((c) => c.startsWith("reconcile:")).length;
    await runSendStep(f.deps());
    expect(f.gmail.calls.filter((c) => c.startsWith("reconcile:")).length).toBe(before); // only 'sending' / 'uncertain' rows are reconciled
  });
  it("a contact is never marked fully sent because of it, and its Connection is not marked Messaged", async () => {
    const f = buildSendFixture(people(2));
    await f.seed();
    for (let i = 0; i < 2; i++) f.gmail.markSentOutside(draftOf(i, "lukky"));
    await runSendStep(f.deps());
    expect(f.track().some((t) => t[21] === "sent")).toBe(false);
    expect(f.calls.markMessaged).toHaveLength(0);
  });
});

describe("N. parking failures and the 25-note limit", () => {
  it("a failed Sheets write while parking changes nothing about sending: no claim, no send for the stale draft, now or on any later call", async () => {
    const f = buildSendFixture(people(3));
    await f.seed();
    for (let i = 0; i < 3; i++) f.gmail.markSentOutside(draftOf(i, "lukky"));
    const deps = f.deps();
    deps.drafts.setParked = async () => { throw new Error("Sheets 429"); };
    const r = await runSendStep(deps);
    expect(r.parkedChanges ?? 0).toBe(0);
    expect(r.sent).toBe(6);
    for (let k = 1; k <= 3; k++) { f.clock.now = new Date(NOW.getTime() + k * 3 * 60_000); await runSendStep(deps); }
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:lukky"))).toHaveLength(0);
    expect(f.ledger().filter((x) => x[MEMBER] === "lukky")).toHaveLength(0);
  });

  it("parking runs AFTER the sends, so it can never use up the time they need", async () => {
    const f = buildSendFixture(people(12));
    await f.seed();
    for (let i = 0; i < 12; i++) f.gmail.markSentOutside(draftOf(i, "lukky"));
    const events: string[] = [];
    const orig = f.gmail.send.bind(f.gmail);
    f.gmail.send = async (m, id) => { events.push("send"); return orig(m, id); };
    const deps = f.deps();
    const park = deps.drafts.setParked!;
    deps.drafts.setParked = async (m, c, r) => { events.push("park"); await new Promise((res) => setTimeout(res, 20)); return park(m, c, r); };
    const r = await runSendStep(deps);
    expect(r.sent).toBe(24);
    expect(events.lastIndexOf("send")).toBeLessThan(events.indexOf("park"));
    expect(events.filter((e) => e === "park")).toHaveLength(12);
  });

  it("at most 25 notes per call, but every call makes progress, so the stale backlog drains completely over a few calls while valid sends are unaffected", async () => {
    const f = buildSendFixture(people(60));
    await f.seed();
    for (let i = 0; i < 60; i++) f.gmail.markSentOutside(draftOf(i, "lukky"));
    const parkedAfter: number[] = [];
    let sent = 0;
    for (let k = 0; k < 4; k++) {
      f.clock.now = new Date(NOW.getTime() + k * 3 * 60_000);
      const r = await runSendStep(f.deps());
      sent += r.sent;
      parkedAfter.push(f.calls.parked.length);
    }
    expect(parkedAfter).toEqual([25, 50, 60, 60]); // 25 per call until none are left
    expect(sent).toBe(120); // Anni + Rishii, all sent in the first call; nothing waited behind the stale drafts
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:lukky"))).toHaveLength(0);
  }, 120_000);
});

describe("O. production compatibility: older rows need no migration", () => {
  it("every pre-existing ledger status still parses unchanged, the new one round-trips, and an unknown status is still ignored", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    await runSendStep(f.deps());
    const base = (await f.sheet.readSendLedger()).records[0];
    const OLD = ["claimed", "sending", "sent", "uncertain", "failed_transient", "failed_permanent", "needs_review", "superseded", "released"] as const;
    for (const status of [...OLD, "sent_outside" as const]) {
      const cells = serializeSendRecord({ ...base, status });
      expect(parseSendRecord(cells, 5)?.status).toBe(status);
    }
    expect(parseSendRecord(serializeSendRecord({ ...base, status: "bogus" as never }), 5)).toBeNull();
  });
  it("the Send Ledger has the same columns: nothing about the sheet layout changed", async () => {
    const { SEND_LEDGER_HEADERS } = await import("@/lib/outreach/headers");
    expect(SEND_LEDGER_HEADERS).toHaveLength(24);
    expect(SEND_LEDGER_HEADERS[3]).toBe("Status");
    expect(SEND_LEDGER_HEADERS[14]).toBe("GmailMessageID");
  });
});
