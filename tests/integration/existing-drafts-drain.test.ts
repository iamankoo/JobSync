/**
 * Draining EVERY existing JobSync-created draft, however old: discovery, a decision per draft (send / leave untouched and record why /
 * reconcile first), safe resumption, and the interplay with the 100-draft backlog gate. Mock Gmail and in-memory Sheets only: nothing real
 * is contacted and no e-mail is sent.
 */
import { describe, expect, it, vi } from "vitest";
import type { MemberId } from "@/config/members";
import { createBacklogGate, type BacklogPorts } from "@/lib/gmail/draft-backlog";
import { hasReviewFlag, isParkedDetail, normalizeParkReason, parkedReasonOf, withParkedReason } from "@/lib/gmail/draft-flags";
import type { ReadResult } from "@/lib/gmail/send";
import { loadNetworkFinderConfig } from "@/lib/network-finder/config";
import { draftForContact, runPendingDrafts, type PipelineDeps } from "@/lib/network-finder/pipeline";
import { ADOPT_PER_RUN, adoptExistingDrafts, connectionsWithUnsentDrafts } from "@/lib/outreach/existing-drafts";
import { registerManualConnections } from "@/lib/outreach/manual";
import { sendKeyFor } from "@/lib/outreach/send-ledger";
import { runSendStep } from "@/lib/outreach/send-workflow";
import type { SendRecord } from "@/lib/outreach/types";
import { MockMailboxes } from "../helpers/network-finder-mocks";
import { buildSendFixture, resumeFile, type ContactSpec } from "../helpers/send-fixture";

const ALL: MemberId[] = ["anni", "lukky", "rishii"];
const OLD = (i: number) => `2026-08-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`; // months before "now": far outside any recency window
type Fx = ReturnType<typeof buildSendFixture>;

/** n contacts whose drafts exist in all three mailboxes but whose Connections have NO tracking row yet (the situation to repair). */
const legacy = (specs: ContactSpec[]): Fx => {
  const f = buildSendFixture(specs.map((s) => ({ members: ALL, ...s })));
  [...f.connections.values()].forEach((c, i) => Object.assign(c, { createdAt: OLD(i), updatedAt: OLD(i), notes: "Source: Network Finder" }));
  return f;
};
const people = (n: number): ContactSpec[] => Array.from({ length: n }, (_, i) => ({ email: `p${i}@c${i}.example.com`, name: `Pat Person${i}`, company: `Co${i}`, members: ALL }));

const adopt = async (f: Fx, over: Partial<Parameters<typeof adoptExistingDrafts>[0]> = {}) => {
  await f.sheet.ensureTabs();
  return adoptExistingDrafts({ sheet: f.sheet, connections: { listFresh: async () => [...f.connections.values()] }, ledger: async () => new Map(f.draftLedger), now: () => f.clock.now, park: async (k, reason) => { const cur = f.draftLedger.get(k); if (cur) f.draftLedger.set(k, { ...cur, detail: withParkedReason(cur.detail, reason) }); }, ...over });
};
const draftOwner = (draftId: string) => draftId.split("_")[2] as MemberId;

// ---------------------------------------------------------------------------------------------------------------------------------
describe("1. old JobSync-created drafts are discovered and processed, not only new ones", () => {
  it("a Connection that has unsent drafts but no tracking row (e.g. Network Finder, or older than the manual window) is invisible to the send step until registered", async () => {
    const f = legacy(people(3));
    await f.sheet.ensureTabs();
    expect((await runSendStep(f.deps())).sent).toBe(0); // the send step only looks at tracked Connections
    // and the manual registration cannot find them: Network Finder Connections are skipped, and these are months old
    const manual = await registerManualConnections({ sheet: f.sheet, connections: { listFresh: async () => [...f.connections.values()] }, now: () => f.clock.now });
    expect(manual.registered).toBe(0);
  });

  it("registers every such Connection however old (source 'existing-draft'), then the send step sends all three members' e-mails for each", async () => {
    const f = legacy(people(5));
    const a = await adopt(f);
    expect(a).toEqual({ adopted: 5, remaining: 0, orphaned: 0, parked: 0 });
    expect(f.track().map((t) => t[2])).toEqual(Array(5).fill("existing-draft")); // never mistaken for an import
    expect(f.track().every((t) => t[3] === "added" && t[4].startsWith("conn_"))).toBe(true);
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ sent: 15, errors: [] });
    expect(f.ledger().filter((l) => l[3] === "sent")).toHaveLength(15);
    expect(f.track().every((t) => t[21] === "sent")).toBe(true);
    for (const c of f.connections.values()) expect(c.status).toBe("Messaged");
  });

  it("the oldest Connection is looked at first", async () => {
    const f = legacy(people(4));
    const conns = [...f.connections.values()];
    conns[0].createdAt = "2026-09-01T00:00:00.000Z"; // newest
    conns[3].createdAt = "2026-06-01T00:00:00.000Z"; // oldest
    await adopt(f);
    expect(f.track().map((t) => t[4])[0]).toBe("conn_3");
    await runSendStep(f.deps({ deadline: undefined }));
    expect(f.gmail.sentMessages[0].draftId).toMatch(/^draft_3_/);
  });

  it("registration is idempotent and never double-registers a Connection that is already tracked (imported or manual)", async () => {
    const f = legacy(people(4));
    await f.sheet.ensureTabs();
    // conn_0 is already tracked (as an import would be): it must not get a second row
    await f.sheet.appendTracking({ ...f.tracking[0], source: "outreach-database" }, 2);
    expect((await adopt(f)).adopted).toBe(3);
    expect((await adopt(f)).adopted).toBe(0);
    expect((await adopt(f)).adopted).toBe(0);
    expect(f.track().map((t) => t[4]).sort()).toEqual(["conn_0", "conn_1", "conn_2", "conn_3"]);
  });

  it("registration is bounded per call (bookkeeping only, it never limits sending) and resumes where it stopped", async () => {
    expect(ADOPT_PER_RUN).toBeGreaterThanOrEqual(1);
    const f = legacy(people(5));
    expect(await adopt(f, { perRun: 2 })).toMatchObject({ adopted: 2, remaining: 3 });
    expect(await adopt(f, { perRun: 2 })).toMatchObject({ adopted: 2, remaining: 1 });
    expect(await adopt(f, { perRun: 2 })).toMatchObject({ adopted: 1, remaining: 0 });
    expect(new Set(f.track().map((t) => t[4])).size).toBe(5);
  });

  it("an interrupted registration (deadline passed) simply continues on the next call, with no duplicate rows", async () => {
    const f = legacy(people(4));
    expect((await adopt(f, { deadline: Date.now() - 1 })).adopted).toBe(0);
    expect((await adopt(f)).adopted).toBe(4);
    expect(new Set(f.track().map((t) => t[4])).size).toBe(4);
  });

  it("drafts whose Connection no longer exists are left untouched and reported, never sent", async () => {
    const f = legacy(people(3));
    f.connections.delete("conn_1");
    const before = new Map(f.gmail.drafts);
    const a = await adopt(f);
    expect(a).toMatchObject({ adopted: 2, orphaned: 1, parked: 3 });
    await runSendStep(f.deps());
    expect(f.gmail.sentMessages.some((m) => m.draftId.startsWith("draft_1_"))).toBe(false);
    // recorded as "cannot be sent" (so it leaves the eligible backlog), and the draft itself in Gmail is exactly as it was
    for (const m of ALL) expect(parkedReasonOf(f.draftLedger.get(`contact:conn_1:${m}`)!.detail)).toMatch(/no longer exists/);
    for (const m of ALL) expect(f.gmail.drafts.get(`draft_1_${m}`)).toBe(before.get(`draft_1_${m}`));
    expect((await adopt(f)).parked).toBe(0); // recorded once
  });

  it("only drafts that are still unsent ('created' with a Gmail id) make a Connection wanted", () => {
    const ledger = new Map([
      ["contact:a:anni", { status: "created", detail: "", gmailDraftId: "d1" }],
      ["contact:b:anni", { status: "sent", detail: "", gmailDraftId: "d2" }],
      ["contact:c:anni", { status: "failed", detail: "", gmailDraftId: "" }],
      ["contact:d:lukky", { status: "skipped_unauthorized", detail: "", gmailDraftId: "" }],
      ["job:e:anni", { status: "created", detail: "", gmailDraftId: "d5" }],
    ]);
    expect([...connectionsWithUnsentDrafts(ledger)]).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("2. eligible drafts skipped in earlier runs are eventually sent", () => {
  it("a member whose Gmail was disconnected during earlier runs is sent as soon as it is connected again; nothing is sent twice", async () => {
    const f = legacy(people(3));
    await adopt(f);
    f.gmail.addresses.lukky = null; // earlier runs: lukky's Gmail not connected -> his drafts were skipped
    const earlier = await runSendStep(f.deps());
    expect(earlier.sent).toBe(6);
    expect(f.gmail.sentMessages.every((m) => m.member !== "lukky")).toBe(true);
    f.gmail.addresses.lukky = "lakshya@gmail.test";
    const later = await runSendStep(f.deps());
    expect(later.sent).toBe(3);
    expect(f.gmail.sentMessages.filter((m) => m.member === "lukky")).toHaveLength(3);
    expect(f.gmail.sendCalls()).toHaveLength(9);
    expect((await runSendStep(f.deps())).sent).toBe(0);
  });

  it("drafts left over by earlier runs that ran out of time are picked up by the next calls until none is left", async () => {
    const f = legacy(people(6));
    await adopt(f);
    const perCall: number[] = [];
    for (let call = 0; call < 10; call++) {
      const before = f.gmail.sentMessages.length;
      const deps = f.deps();
      Object.defineProperty(deps, "deadline", { get: () => (f.gmail.sentMessages.length - before >= 5 ? Date.now() - 1 : Date.now() + 60_000) });
      const r = await runSendStep(deps);
      perCall.push(r.sent);
      if (r.sent === 0) break;
    }
    expect(perCall).toEqual([5, 5, 5, 3, 0]);
    expect(f.gmail.sentMessages).toHaveLength(18);
    expect(new Set(f.gmail.sentMessages.map((m) => m.draftId)).size).toBe(18);
  });

  it("a draft that was waiting because Gmail asked its account to slow down is sent once the cool-down is over", async () => {
    const f = legacy(people(2));
    await adopt(f);
    f.gmail.sendScript = [{ status: "rate_limited" }];
    const first = await runSendStep(f.deps());
    expect(first.stoppedBecause).toBe("rate-limited");
    f.clock.now = new Date(f.clock.now.getTime() + 20 * 60_000);
    await runSendStep(f.deps());
    expect(f.gmail.sentMessages).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("3-4. each draft goes out only through ITS member's Gmail, with that member's resume", () => {
  it("every send is made from the account that owns the draft, and the resume recorded is that member's own", async () => {
    const f = legacy(people(4));
    await adopt(f);
    await runSendStep(f.deps());
    expect(f.gmail.sentMessages).toHaveLength(12);
    for (const m of f.gmail.sentMessages) expect(m.member).toBe(draftOwner(m.draftId));
    for (const row of f.ledger().filter((l) => l[3] === "sent")) {
      expect(row[4]).toBe(draftOwner(row[12])); // ledger member = the draft's owner
      expect(row[9]).toBe(resumeFile(row[4] as MemberId)); // that member's own resume, never another's
      expect(row[5]).toBe(f.gmail.addresses[row[4] as MemberId]); // sent from that member's own address
    }
  });

  it("a draft that is not the sending member's own (ledger entry pointing at another member's mailbox draft) is NOT sent", async () => {
    const f = legacy(people(1));
    f.draftLedger.set("contact:conn_0:lukky", { ...f.draftLedger.get("contact:conn_0:lukky")!, gmailDraftId: "draft_0_anni" });
    await adopt(f);
    await runSendStep(f.deps());
    expect(f.gmail.sentMessages.filter((m) => m.member === "lukky")).toHaveLength(0);
    expect(f.gmail.sentMessages.map((m) => m.member).sort()).toEqual(["anni", "rishii"]);
  });

  it("the resume must be attached and be that member's file; a wrong or missing one is never sent", async () => {
    const f = legacy(people(2));
    const wrong = f.gmail.drafts.get("draft_0_rishii") as Extract<ReadResult, { status: "ok" }>;
    f.gmail.drafts.set("draft_0_rishii", { status: "ok", draft: { ...wrong.draft, attachments: [{ filename: resumeFile("anni"), size: wrong.draft.attachments[0].size }] } }); // another member's resume
    const none = f.gmail.drafts.get("draft_1_lukky") as Extract<ReadResult, { status: "ok" }>;
    f.gmail.drafts.set("draft_1_lukky", { status: "ok", draft: { ...none.draft, attachments: [] } }); // no resume at all
    await adopt(f);
    await runSendStep(f.deps());
    expect(f.gmail.sentMessages.some((m) => m.draftId === "draft_0_rishii" || m.draftId === "draft_1_lukky")).toBe(false);
    expect(f.gmail.sentMessages).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("5. every draft is decided on its merits; the unsendable ones stay untouched in Gmail with a recorded reason", () => {
  /** 7 old Connections, each with one kind of situation. */
  async function mixed() {
    const f = legacy(people(7));
    f.connections.get("conn_3")!.email = "not-an-address";
    f.tracking.length = 0;
    // 0 good | 1 lukky has no resume | 2 opted out | 3 invalid recipient | 4 same recipient as 0 | 5 anni's earlier send is UNCERTAIN | 6 good
    const lukky1 = f.gmail.drafts.get("draft_1_lukky") as Extract<ReadResult, { status: "ok" }>;
    f.gmail.drafts.set("draft_1_lukky", { status: "ok", draft: { ...lukky1.draft, attachments: [] } });
    f.fake.tabs.set("Outreach Exclusions", [["Value", "Reason", "AddedAt", "AddedBy"], ["p2@c2.example.com", "asked not to be contacted", "", "anni"]]);
    f.connections.get("conn_4")!.email = "p0@c0.example.com";
    for (const m of ALL) {
      const d4 = f.gmail.drafts.get(`draft_4_${m}`) as Extract<ReadResult, { status: "ok" }>;
      f.gmail.drafts.set(`draft_4_${m}`, { status: "ok", draft: { ...d4.draft, to: "p0@c0.example.com" } });
    }
    await f.sheet.ensureTabs();
    const { nextRow } = await f.sheet.readSendLedger();
    const at = new Date(f.clock.now.getTime() - 3600_000).toISOString();
    const uncertain: SendRecord = {
      row: 0, sendKey: sendKeyFor("anni", "p5@c5.example.com"), contactId: "x", claimId: "earlier-uncertain", status: "uncertain", member: "anni", gmailAccount: "aniket@gmail.test", connectionId: "conn_5", company: "Co5", role: "SDE",
      resumeFile: resumeFile("anni"), resumeSha256: "0".repeat(64), resumeBytes: 10, draftId: "draft_5_anni", threadId: "", gmailMessageId: "", wordCount: 100, attempts: 1, notBefore: "", sentAt: "", sentDay: "", reason: "timeout",
      history: "", createdAt: at, updatedAt: at,
    };
    await f.sheet.appendSendRecord(uncertain, nextRow);
    const before = new Map(f.gmail.drafts);
    await adopt(f);
    return { f, before };
  }
  const detailOf = (f: Fx, conn: number, m: MemberId) => f.draftLedger.get(`contact:conn_${conn}:${m}`)!.detail;

  it("sends exactly the eligible drafts and nothing else", async () => {
    const { f } = await mixed();
    const r = await runSendStep(f.deps());
    const sent = f.gmail.sentMessages.map((m) => m.draftId).sort();
    expect(sent).toEqual([
      "draft_0_anni", "draft_0_lukky", "draft_0_rishii", // good
      "draft_1_anni", "draft_1_rishii", // lukky's has no resume
      "draft_5_lukky", "draft_5_rishii", // anni's earlier send is uncertain
      "draft_6_anni", "draft_6_lukky", "draft_6_rishii", // good
    ]);
    expect(r.sent).toBe(10);
  });

  it("missing resume: not sent, the reason is recorded, the Gmail draft is untouched, the contact is flagged for review", async () => {
    const { f, before } = await mixed();
    await runSendStep(f.deps());
    expect(parkedReasonOf(detailOf(f, 1, "lukky"))).toMatch(/attachment/i);
    expect(f.gmail.drafts.get("draft_1_lukky")).toBe(before.get("draft_1_lukky")); // not touched
    expect(f.track()[1][21]).toBe("review");
    expect(f.track()[1][25]).toMatch(/lukky: \[resume\]/);
  });

  it("opted out: not sent, the reason is recorded", async () => {
    const { f } = await mixed();
    await runSendStep(f.deps());
    for (const m of ALL) expect(parkedReasonOf(detailOf(f, 2, m)), m).toMatch(/opted out.*asked not to be contacted/);
    expect(f.gmail.sendCalls().some((c) => c.includes("draft_2_"))).toBe(false);
  });

  it("invalid recipient: not sent, the reason is recorded", async () => {
    const { f } = await mixed();
    await runSendStep(f.deps());
    for (const m of ALL) expect(parkedReasonOf(detailOf(f, 3, m)), m).toMatch(/invalid recipient/);
    expect(f.gmail.sendCalls().some((c) => c.includes("draft_3_"))).toBe(false);
  });

  it("duplicate recipient: the second Connection of an address already e-mailed is not sent, the reason is recorded", async () => {
    const { f } = await mixed();
    await runSendStep(f.deps());
    for (const m of ALL) expect(parkedReasonOf(detailOf(f, 4, m)), m).toMatch(/already sent/);
    expect(f.gmail.sendCalls().some((c) => c.includes("draft_4_"))).toBe(false);
    expect(f.gmail.sentMessages.filter((m) => m.draftId.startsWith("draft_0_"))).toHaveLength(3); // the first Connection did send, once per member
  });

  it("uncertain earlier send: reconciled against Gmail first, never resent while unresolved, and NOT parked (it is still an unresolved pending draft)", async () => {
    const { f } = await mixed();
    f.gmail.reconcileScript = [{ state: "unknown", reason: "metadata permission missing" }];
    await runSendStep(f.deps());
    expect(f.gmail.calls.some((c) => c.startsWith("reconcile:anni:draft_5_anni"))).toBe(true); // reconciled BEFORE anything was decided
    expect(f.gmail.sendCalls().some((c) => c === "send:anni:draft_5_anni")).toBe(false);
    for (let day = 1; day <= 3; day++) {
      f.clock.now = new Date(f.clock.now.getTime() + day * 24 * 3600_000);
      f.gmail.reconcileScript = [{ state: "unknown", reason: "still unknown" }];
      await runSendStep(f.deps());
    }
    expect(f.gmail.sendCalls().some((c) => c === "send:anni:draft_5_anni")).toBe(false);
    expect(parkedReasonOf(detailOf(f, 5, "anni"))).toBeNull();
    expect(f.ledger().find((l) => l[0] === sendKeyFor("anni", "p5@c5.example.com"))![3]).toBe("uncertain");
  });

  it("an earlier uncertain send that Gmail PROVES was sent is recorded from Gmail's own message id and its draft is never sent again", async () => {
    const { f } = await mixed();
    f.gmail.reconcileScript = [{ state: "sent", messageId: "msg-proven" }];
    await runSendStep(f.deps());
    const row = f.ledger().find((l) => l[0] === sendKeyFor("anni", "p5@c5.example.com"))!;
    expect(row[3]).toBe("sent");
    expect(row[14]).toBe("msg-proven");
    expect(f.gmail.sendCalls().some((c) => c === "send:anni:draft_5_anni")).toBe(false);
  });

  it("unsendable drafts are never touched in Gmail, however many calls pass, and no further notes are written once they are recorded", async () => {
    const { f, before } = await mixed();
    await runSendStep(f.deps());
    const notes = f.calls.parked.length;
    expect(notes).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) await runSendStep(f.deps());
    expect(f.calls.parked.length).toBe(notes); // the same finding is recorded once
    for (const id of ["draft_1_lukky", "draft_2_anni", "draft_2_lukky", "draft_2_rishii", "draft_3_anni", "draft_4_anni", "draft_5_anni"]) expect(f.gmail.drafts.get(id)).toBe(before.get(id));
    expect(f.gmail.sentMessages).toHaveLength(10);
  });

  it("a note is lifted when the reason goes away (the recipient is taken off the opt-out list): the draft is then sent", async () => {
    const { f } = await mixed();
    await runSendStep(f.deps());
    expect(isParkedDetail(detailOf(f, 2, "anni"))).toBe(true);
    f.fake.tabs.set("Outreach Exclusions", [["Value", "Reason", "AddedAt", "AddedBy"]]);
    await runSendStep(f.deps());
    expect(f.gmail.sentMessages.filter((m) => m.draftId.startsWith("draft_2_"))).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("6. a confirmed draft is never sent twice", () => {
  it("even if the draft ledger still says 'created' (the follow-up update was lost), the durable send ledger prevents a second send", async () => {
    const f = legacy(people(2));
    await adopt(f);
    await runSendStep(f.deps());
    expect(f.gmail.sentMessages).toHaveLength(6);
    for (const [k, v] of f.draftLedger) f.draftLedger.set(k, { ...v, status: "created" }); // as if every markSent had been lost
    f.track().forEach(() => undefined);
    for (let i = 0; i < 3; i++) await runSendStep(f.deps());
    expect(f.gmail.sendCalls()).toHaveLength(6);
    expect(f.ledger().filter((l) => l[3] === "sent").every((l) => l[14].startsWith("msg-"))).toBe(true); // every confirmed send carries Gmail's message id
  });

  it("registering the same Connections again after they were sent does not create anything to send", async () => {
    const f = legacy(people(2));
    await adopt(f);
    await runSendStep(f.deps());
    for (const [k, v] of f.draftLedger) f.draftLedger.set(k, { ...v, status: "created" });
    expect((await adopt(f)).adopted).toBe(0);
    await runSendStep(f.deps());
    expect(f.gmail.sendCalls()).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("7. processing resumes safely after a timeout or an interrupted cron execution", () => {
  it("a crash right after 'sending' is reconciled against Gmail first; the crashed send is not repeated and the rest continues", async () => {
    const f = legacy(people(3));
    await adopt(f);
    f.gmail.sendScript = ["throw"];
    const crashed = await runSendStep(f.deps());
    expect(crashed.stoppedBecause).toBe("error");
    expect(f.ledger().map((l) => l[3])).toEqual(["sending"]);
    await runSendStep(f.deps()); // an overlapping call right afterwards must leave that key alone
    expect(f.gmail.sendCalls().filter((c) => c === "send:anni:draft_0_anni")).toHaveLength(1);
    f.clock.now = new Date(f.clock.now.getTime() + 3 * 60_000);
    f.gmail.reconcileScript = [{ state: "sent", messageId: "msg-proved" }];
    await runSendStep(f.deps());
    expect(f.ledger().find((l) => l[0] === sendKeyFor("anni", "p0@c0.example.com"))![14]).toBe("msg-proved");
    expect(f.gmail.sendCalls()).toHaveLength(9);
    expect(new Set(f.gmail.sendCalls()).size).toBe(9);
  });

  it("a crash where Gmail shows the draft is STILL there (not sent) is retried only after the back-off", async () => {
    const f = legacy(people(1));
    await adopt(f);
    f.gmail.sendScript = ["throw"];
    await runSendStep(f.deps());
    f.clock.now = new Date(f.clock.now.getTime() + 3 * 60_000);
    f.gmail.reconcileScript = [{ state: "not_sent" }];
    await runSendStep(f.deps());
    expect(f.gmail.sendCalls().filter((c) => c === "send:anni:draft_0_anni")).toHaveLength(1); // not retried yet
    f.clock.now = new Date(f.clock.now.getTime() + 15 * 60_000);
    await runSendStep(f.deps());
    expect(f.gmail.sentMessages).toHaveLength(3);
    expect(f.gmail.sendCalls().filter((c) => c === "send:anni:draft_0_anni")).toHaveLength(2); // exactly one retry, then done
  });

  it("concurrent executions never send a draft twice, and the registration step is safe to run concurrently too", async () => {
    const f = legacy(people(8));
    await f.sheet.ensureTabs();
    await Promise.all([adopt(f), adopt(f)]).catch(() => undefined);
    await adopt(f); // whatever the overlap left undone is finished
    const conns = f.track().map((t) => t[4]);
    expect(new Set(conns).size).toBeGreaterThanOrEqual(8); // every Connection is tracked
    await Promise.all([runSendStep(f.deps()), runSendStep(f.deps()), runSendStep(f.deps())]);
    await runSendStep(f.deps());
    const sent = f.ledger().filter((l) => l[3] === "sent");
    expect(new Set(sent.map((l) => l[0])).size).toBe(sent.length);
    expect(new Set(f.gmail.sendCalls()).size).toBe(f.gmail.sendCalls().length);
    expect(sent).toHaveLength(24);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("8. the backlog gate and existing drafts", () => {
  /** The gate's counting ports over the fixture: the draft ledger, and what is really still in each member's (mock) Gmail. */
  const portsOf = (f: Fx): BacklogPorts => ({
    ledgerPending: async () => [...f.draftLedger].filter(([, v]) => v.status === "created" && v.gmailDraftId).map(([k, v]) => ({ memberId: k.split(":")[2] as MemberId, gmailDraftId: v.gmailDraftId, detail: v.detail })),
    gmailDraftIds: async (m) => ({ status: "ok", ids: new Set([...f.gmail.drafts.keys()].filter((id) => id.endsWith(`_${m}`) && !f.gmail.sentMessages.some((s) => s.draftId === id))) }),
  });
  const config = loadNetworkFinderConfig({ DRAFT_DELAY_MINUTES: "0", NETWORK_FINDER_ENABLED: "true" } as unknown as NodeJS.ProcessEnv);

  it("existing drafts are in the count, PER MEMBER: 40 old unsent drafts each (limit 37 here) pause everyone; as each member's own count drops below the limit THAT member drafts again, while the ones needing a person stay untouched", async () => {
    // 40 old Connections x 3 members = 120 drafts. The last 8 Connections are opted out (24 drafts that can never be sent).
    const f = legacy(people(40));
    f.fake.tabs.set("Outreach Exclusions", [["Value", "Reason", "AddedAt", "AddedBy"], ...Array.from({ length: 8 }, (_, i) => [`p${32 + i}@c${32 + i}.example.com`, "opt out", "", "anni"])]);
    const gate = createBacklogGate({ ports: portsOf(f), ttlMs: 0, limit: 37 });
    const mail = new MockMailboxes();
    const target = { connectionId: "new1", name: "Newly Found", title: "Head of Eng", email: "new1@fresh.example.com", company: { name: "FreshCo" } };

    expect(await gate.check()).toMatchObject({ allowed: false, pending: 120 }); // before anything is registered or sent: every member has 40
    expect((await draftForContact({ config, drafts: Object.assign(mail, { backlog: gate }) }, target)).every((o) => o.result === "paused_backlog")).toBe(true);

    await adopt(f);
    // a first call that only has time for 10 sends (contacts 0-2 for everyone, contact 3 for Anni): Anni 36, Lukky 37, Rishii 37
    const deps = f.deps();
    Object.defineProperty(deps, "deadline", { get: () => (f.gmail.sentMessages.length >= 10 ? Date.now() - 1 : Date.now() + 60_000) });
    await runSendStep(deps);
    expect(f.gmail.sentMessages).toHaveLength(10);
    expect(await gate.check("anni")).toMatchObject({ allowed: true, pending: 36 });
    expect(await gate.check("lukky")).toMatchObject({ allowed: false, pending: 37 });
    expect(await gate.check("rishii")).toMatchObject({ allowed: false, pending: 37 });
    expect((await draftForContact({ config, drafts: Object.assign(mail, { backlog: gate }) }, target)).map((o) => o.result)).toEqual(["created", "paused_backlog", "paused_backlog"]);
    expect(mail.drafts.map((d) => d.memberId)).toEqual(["anni"]);

    // later calls drain everything that is eligible
    for (let i = 0; i < 6; i++) await runSendStep(f.deps());
    expect(f.gmail.sentMessages).toHaveLength(96); // 32 Connections x 3
    const after = await gate.check();
    expect(after).toMatchObject({ allowed: true, pending: 0 });
    expect(createBacklogGate({ ports: portsOf(f), ttlMs: 0 }).last()).toBeNull();

    // the 24 drafts needing a person are still in Gmail, untouched, recorded and reported (not silently discarded)
    const stillThere = [...f.draftLedger].filter(([, v]) => v.status === "created");
    expect(stillThere).toHaveLength(24);
    expect(stillThere.every(([, v]) => parkedReasonOf(v.detail)?.includes("opted out"))).toBe(true);
    const counted = await (await import("@/lib/gmail/draft-backlog")).countPendingGmailDrafts(portsOf(f));
    expect(counted).toMatchObject({ status: "ok", pending: 0, parked: 24 });
    // drafting resumes for the two who were paused; Anni's draft from before is never made twice
    expect((await draftForContact({ config, drafts: Object.assign(mail, { backlog: gate }) }, target)).map((o) => o.result)).toEqual(["already_drafted", "created", "created"]);
  }, 240_000);

  it("drafts flagged for review when they were made, and drafts parked by the send step, stay out of the ELIGIBLE count (but are never deleted)", async () => {
    const f = legacy(people(3));
    f.draftLedger.set("contact:conn_0:anni", { ...f.draftLedger.get("contact:conn_0:anni")!, detail: "review: company research unavailable" });
    f.draftLedger.set("contact:conn_1:lukky", { ...f.draftLedger.get("contact:conn_1:lukky")!, detail: withParkedReason("attached: x.pdf", "resume is missing") });
    const { countPendingGmailDrafts } = await import("@/lib/gmail/draft-backlog");
    expect(await countPendingGmailDrafts(portsOf(f))).toMatchObject({ status: "ok", pending: 7, parked: 2 });
    expect(f.gmail.drafts.size).toBe(9); // all nine drafts are still in Gmail
  });

  it("the gate prevents new drafts while eligible existing drafts are waiting, but never blocks sending them", async () => {
    const f = legacy(people(40)); // 40 eligible drafts per member
    await adopt(f);
    const gate = createBacklogGate({ ports: portsOf(f), ttlMs: 0, limit: 40 });
    expect((await gate.check()).allowed).toBe(false);
    const r = await runSendStep(f.deps()); // sending is not gated: it runs and drains
    expect(r.sent).toBe(120);
    expect((await gate.check()).allowed).toBe(true);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("5. no replacement draft for a recipient who already has a valid pending draft", () => {
  const config = loadNetworkFinderConfig({ DRAFT_DELAY_MINUTES: "0", NETWORK_FINDER_ENABLED: "true" } as unknown as NodeJS.ProcessEnv);
  const conn = (id: string, email: string) => ({ connectionId: id, memberId: "anni", name: `Person ${id}`, company: "Acme", email, status: "Not Connected", createdAt: new Date().toISOString(), notes: "" });

  function worker(existing: Record<string, { status: string; detail?: string }>, conns: ReturnType<typeof conn>[]) {
    const mail = new MockMailboxes();
    const snapshot = async () => new Map(Object.entries(existing));
    const deps = { config, drafts: Object.assign(mail, { snapshot }), connections: { list: async () => conns }, registry: { all: async () => [] }, runState: {} } as unknown as PipelineDeps;
    return { mail, deps };
  }
  const validFor = (id: string, detail = "attached: r.pdf") => Object.fromEntries(ALL.map((m) => [`contact:${id}:${m}`, { status: "created", detail }]));

  it("another Connection with the same address and a valid pending draft in each mailbox -> no second draft is written", async () => {
    const { mail, deps } = worker(validFor("old1"), [conn("old1", "same@acme.example.com"), conn("new1", "SAME@acme.example.com")]);
    const r = await runPendingDrafts(deps, { limit: 10 });
    expect(r.created).toBe(0);
    expect(mail.drafts).toEqual([]);
  });

  it("only the members who actually have a valid pending draft are skipped; the others still get theirs", async () => {
    const existing = { "contact:old1:anni": { status: "created", detail: "attached: r.pdf" } };
    const { mail, deps } = worker(existing, [conn("old1", "same@acme.example.com"), conn("new1", "same@acme.example.com")]);
    await runPendingDrafts(deps, { limit: 10 });
    expect(mail.drafts.map((d) => d.memberId).sort()).toEqual(["lukky", "rishii"]);
  });

  it("a recipient already e-mailed by a member (sent draft) is not drafted again for that member", async () => {
    const existing = Object.fromEntries(ALL.map((m) => [`contact:old1:${m}`, { status: "sent", detail: "" }]));
    const { mail, deps } = worker(existing, [conn("old1", "same@acme.example.com"), conn("new1", "same@acme.example.com")]);
    await runPendingDrafts(deps, { limit: 10 });
    expect(mail.drafts).toEqual([]);
  });

  it("an existing draft that is parked or flagged for review is still the recipient's draft: it is never silently replaced by a second one", async () => {
    const { mail, deps } = worker(validFor("old1", withParkedReason("attached: r.pdf", "resume is missing")), [conn("old1", "same@acme.example.com"), conn("new1", "same@acme.example.com")]);
    await runPendingDrafts(deps, { limit: 10 });
    expect(mail.drafts).toEqual([]);
  });

  it("within ONE run two Connections for the same recipient get one set of drafts between them, not two", async () => {
    const { mail, deps } = worker({}, [conn("a1", "twin@acme.example.com"), conn("a2", "twin@acme.example.com")]);
    await runPendingDrafts(deps, { limit: 10 });
    expect(mail.drafts.map((d) => d.memberId).sort()).toEqual(ALL);
  });

  it("drafts that members wrote by hand in Gmail are not in the ledger, so they are never counted, adopted, sent, touched or replaced", async () => {
    const f = legacy(people(2));
    f.gmail.drafts.set("hand_written_1", { status: "ok", draft: { to: "p0@c0.example.com", from: "aniket@gmail.test", subject: "my own note", body: "hello", attachments: [] } });
    await adopt(f);
    await runSendStep(f.deps());
    expect(f.gmail.sendCalls().some((c) => c.includes("hand_written"))).toBe(false);
    expect(f.gmail.calls.some((c) => c.includes("hand_written"))).toBe(false); // not even read
  });

  it("a different recipient is unaffected", async () => {
    const { mail, deps } = worker(validFor("old1"), [conn("old1", "a@acme.example.com"), conn("new1", "b@acme.example.com")]);
    const r = await runPendingDrafts(deps, { limit: 10 });
    expect(r.created).toBe(3);
    expect(mail.drafts.every((d) => d.to === "b@acme.example.com")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("the notes kept on a draft's ledger row", () => {
  it("round-trip: set, replace, clear; every other part (attached file, review flag) is kept as it was", () => {
    const base = "attached: Aniket_Raj_SDE.pdf; review: company research unavailable";
    const parked = withParkedReason(base, "opted out (asked; not to be contacted)");
    expect(parked).toBe("attached: Aniket_Raj_SDE.pdf; review: company research unavailable; parked: opted out (asked, not to be contacted)");
    expect(parkedReasonOf(parked)).toBe("opted out (asked, not to be contacted)");
    expect(withParkedReason(parked, "resume is missing")).toBe("attached: Aniket_Raj_SDE.pdf; review: company research unavailable; parked: resume is missing");
    expect(withParkedReason(parked, null)).toBe(base);
    expect(withParkedReason("", "x")).toBe("parked: x");
    expect(hasReviewFlag(base)).toBe(true);
    expect(isParkedDetail("attached: a.pdf")).toBe(false);
    expect(isParkedDetail(parked)).toBe(true);
    expect(normalizeParkReason("a ; b\n  c")).toBe("a, b c");
    expect(vi.isMockFunction(withParkedReason)).toBe(false);
  });
});
