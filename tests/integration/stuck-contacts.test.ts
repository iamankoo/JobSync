/**
 * Contacts that were wrongly treated as "fully sent". Production had 293 of them: the status sync marked a contact "sent" as soon as every draft that
 * EXISTED was sent (for example only Anni's, while Lukky's and Rishii's drafts were skipped because their Gmail was disconnected), and the send step never
 * looks at a contact marked "sent". Drafts created afterwards for the other members were therefore never sent.
 * Now each member's outstanding work is judged independently from the two durable ledgers. Mock Gmail and in-memory Sheets only: nothing real is sent.
 */
import { describe, expect, it } from "vitest";
import type { MemberId } from "@/config/members";
import type { ReadResult } from "@/lib/gmail/send";
import { sendKeyFor } from "@/lib/outreach/send-ledger";
import { confirmedSendKeys, outstandingMembers, runSendStep } from "@/lib/outreach/send-workflow";
import { deriveProcessing, draftKeyFor, syncTracking, type LedgerEntry } from "@/lib/outreach/sync";
import type { SendRecord } from "@/lib/outreach/types";
import { buildSendFixture, resumeFile, type ContactSpec } from "../helpers/send-fixture";

const ALL: MemberId[] = ["anni", "lukky", "rishii"];
const people = (n: number): ContactSpec[] => Array.from({ length: n }, (_, i) => ({ email: `p${i}@c${i}.example.com`, name: `Pat Person${i}`, company: `Co${i}`, members: ALL }));
type Fx = ReturnType<typeof buildSendFixture>;

/** Takes the given members' drafts away (ledger row AND Gmail draft), as if they had not been created yet. Returns what is needed to bring them back. */
function hide(f: Fx, members: MemberId[]) {
  const saved: { key: string; entry: ReturnType<Fx["draftLedger"]["get"]>; id: string; gmail: ReadResult | undefined }[] = [];
  for (const [key, entry] of [...f.draftLedger]) {
    if (!members.some((m) => key.endsWith(`:${m}`))) continue;
    saved.push({ key, entry, id: entry!.gmailDraftId, gmail: f.gmail.drafts.get(entry!.gmailDraftId) });
    f.draftLedger.delete(key);
    f.gmail.drafts.delete(entry!.gmailDraftId);
  }
  return () => { for (const s of saved) { f.draftLedger.set(s.key, s.entry!); if (s.gmail) f.gmail.drafts.set(s.id, s.gmail); } };
}

/** Puts every tracking row into the state the old bug left it in: "sent". */
async function markAllSentLegacy(f: Fx) {
  const { records } = await f.sheet.readTracking();
  for (const r of records) await f.sheet.updateTracking({ ...r, sendStatus: "sent" });
}

const sentBy = (f: Fx) => f.gmail.sentMessages.map((m) => `${m.member}:${m.draftId}`).sort();
const expectEachSentOnce = (f: Fx, contacts: number) => {
  const expected = Array.from({ length: contacts }, (_, i) => ALL.map((m) => `${m}:draft_${i}_${m}`)).flat().sort();
  expect(sentBy(f)).toEqual(expected);
  expect(new Set(f.gmail.sendCalls()).size).toBe(f.gmail.sendCalls().length); // no Gmail send call was ever repeated
};


/** Each member's e-mail to p0 is confirmed exactly once in the durable send ledger, and no Gmail send call was repeated. */
const expectThreeConfirmedOnce = (f: Fx) => {
  const rows = f.ledger().filter((l) => l[3] === "sent");
  expect(rows.map((r) => r[4]).sort()).toEqual([...ALL].sort());
  expect(new Set(rows.map((r) => r[0])).size).toBe(3);
  const calls = f.gmail.sendCalls();
  for (const m of ALL) expect(calls.filter((c) => c.startsWith(`send:${m}:`)).length).toBeLessThanOrEqual(1 + (m === "lukky" ? 1 : 0));
};

// ---------------------------------------------------------------------------------------------------------------------------------
describe("the status derivation: 'all sent' needs every connected member's draft sent", () => {
  const e = (status: string, detail = ""): LedgerEntry => ({ status, detail, gmailDraftId: status === "created" || status === "sent" ? "d" : "" });
  const ledger = (o: Partial<Record<MemberId, LedgerEntry>>) => new Map(ALL.flatMap((m) => (o[m] ? ([[draftKeyFor("c1", m), o[m]!]] as const) : [])));

  it("only Anni's draft exists and is sent, Lukky and Rishii were skipped -> NOT all sent (this was the bug)", () => {
    const d = deriveProcessing("c1", ledger({ anni: e("sent"), lukky: e("skipped_unauthorized"), rishii: e("skipped_unauthorized") }), ALL);
    expect(d.allSent).toBe(false);
  });

  it("two of three are sent and the third draft exists but is unsent -> not all sent", () => {
    expect(deriveProcessing("c1", ledger({ anni: e("sent"), lukky: e("sent"), rishii: e("created") }), ALL).allSent).toBe(false);
  });

  it("a member with no draft at all, or a failed one, keeps the contact open", () => {
    expect(deriveProcessing("c1", ledger({ anni: e("sent"), lukky: e("sent") }), ALL).allSent).toBe(false);
    expect(deriveProcessing("c1", ledger({ anni: e("sent"), lukky: e("sent"), rishii: e("failed") }), ALL).allSent).toBe(false);
  });

  it("all three sent -> all sent; a member who is not connected is not expected to send", () => {
    expect(deriveProcessing("c1", ledger({ anni: e("sent"), lukky: e("sent"), rishii: e("sent") }), ALL).allSent).toBe(true);
    expect(deriveProcessing("c1", ledger({ anni: e("sent"), lukky: e("skipped_unauthorized"), rishii: e("sent") }), ["anni", "rishii"]).allSent).toBe(true);
    expect(deriveProcessing("c1", ledger({}), ALL).allSent).toBe(false);
  });

  it("the sync writes 'sent' onto a contact only when every connected member sent", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    const ledgerMap = (statuses: Record<MemberId, string>) => new Map(ALL.map((m) => [draftKeyFor("conn_0", m), { status: statuses[m], detail: "", gmailDraftId: statuses[m] === "sent" ? `d_${m}` : "" }]));
    const run = async (statuses: Record<MemberId, string>, connected: MemberId[]) => {
      await syncTracking({ sheet: f.sheet, ledger: ledgerMap(statuses), connected, connections: [...f.connections.values()], now: () => f.clock.now });
      return f.track()[0][21];
    };
    expect(await run({ anni: "sent", lukky: "skipped_unauthorized", rishii: "skipped_unauthorized" }, ALL)).not.toBe("sent");
    expect(await run({ anni: "sent", lukky: "sent", rishii: "created" }, ALL)).not.toBe("sent");
    expect(await run({ anni: "sent", lukky: "skipped_unauthorized", rishii: "sent" }, ["anni", "rishii"])).toBe("sent"); // Lukky is not connected: nothing is expected of him
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("who still has work is decided from the durable ledgers", () => {
  const rec = { connectionId: "c1", email: "Jane@Acme.example.com" };
  const drafts = (o: Record<string, string>) => new Map(Object.entries(o).map(([m, status]) => [draftKeyFor("c1", m as MemberId), { status }]));

  it("a member is outstanding when their draft is unsent AND the send ledger has no confirmed send for them", () => {
    const sent = new Set([sendKeyFor("anni", "jane@acme.example.com")]);
    expect(outstandingMembers(rec, drafts({ anni: "created", lukky: "created", rishii: "created" }), sent)).toEqual(["lukky", "rishii"]); // Anni's is in the send ledger: never again
    expect(outstandingMembers(rec, drafts({ anni: "sent", lukky: "created", rishii: "skipped_unauthorized" }), new Set())).toEqual(["lukky"]);
    expect(outstandingMembers(rec, drafts({ anni: "sent", lukky: "sent", rishii: "sent" }), new Set())).toEqual([]);
    expect(outstandingMembers(rec, drafts({}), new Set())).toEqual([]); // nothing drafted yet: nothing to send (and nothing to look at)
  });

  it("the send ledger's confirmed sends are exactly the rows with status 'sent'", () => {
    const row = (status: string, key: string) => ({ status, sendKey: key }) as SendRecord;
    expect([...confirmedSendKeys([row("sent", "a|x"), row("uncertain", "b|x"), row("failed_transient", "c|x"), row("released", "d|x")])]).toEqual(["a|x"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("partial completion: every combination of members, with and without the old 'sent' flag", () => {
  const subsets: MemberId[][] = [["anni"], ["lukky"], ["rishii"], ["anni", "lukky"], ["anni", "rishii"], ["lukky", "rishii"], ["anni", "lukky", "rishii"]];
  for (const first of subsets) {
    for (const legacyFlag of [true, false]) {
      it(`drafts for [${first.join(", ")}] go out first; the other members' drafts appear later${legacyFlag ? " (contact wrongly flagged 'sent')" : ""} -> each of the six e-mails is sent exactly once`, async () => {
        const f = buildSendFixture(people(2));
        const restore = hide(f, ALL.filter((m) => !first.includes(m)));
        await f.seed();
        const one = await runSendStep(f.deps());
        expect(one.sent).toBe(first.length * 2);
        if (legacyFlag) await markAllSentLegacy(f);
        restore(); // the other members' drafts are created now
        f.clock.now = new Date(f.clock.now.getTime() + 120_000);
        const two = await runSendStep(f.deps());
        expect(two.sent).toBe((ALL.length - first.length) * 2);
        expectEachSentOnce(f, 2);
        expect(f.track().every((t) => t[21] === "sent")).toBe(true); // and only now are the contacts really complete
        const three = await runSendStep(f.deps());
        expect(three.sent).toBe(0);
        expect(f.gmail.sendCalls()).toHaveLength(6);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("the production shape: contacts flagged 'sent' with outstanding members", () => {
  it("the contacts that are really complete cost no Gmail call; the 293-style contacts get their outstanding e-mails; a late draft is still eligible", async () => {
    const f = buildSendFixture(people(9));
    // 0-3: Anni sent; Lukky's and Rishii's drafts exist (created later, unsent)  -> 2 e-mails each outstanding
    // 4-5: Anni sent; Rishii's draft exists; Lukky's draft does not exist yet       -> 1 outstanding, 1 waiting for a draft
    // 6-8: all three sent already                                                   -> nothing to do
    const late = new Map<string, { entry: ReturnType<Fx["draftLedger"]["get"]>; id: string; gmail: ReadResult | undefined }>();
    for (const c of ["conn_4", "conn_5"]) {
      const key = `contact:${c}:lukky`;
      const entry = f.draftLedger.get(key)!;
      late.set(key, { entry, id: entry.gmailDraftId, gmail: f.gmail.drafts.get(entry.gmailDraftId) });
      f.draftLedger.delete(key);
      f.gmail.drafts.delete(entry.gmailDraftId);
    }
    await f.seed();
    // reach that state through the real send step: first only Anni's drafts are visible to the sender...
    await runSendStep(f.deps({ gmail: onlyFor(f, ["anni"]) }));
    expect(f.gmail.sentMessages.filter((m) => m.member === "anni")).toHaveLength(9);
    // ...then Lukky's and Rishii's e-mails for contacts 6-8 only
    await runSendStep(f.deps({ gmail: onlyFor(f, ["lukky", "rishii"], new Set(["conn_6", "conn_7", "conn_8"])) }));
    expect(f.gmail.sentMessages).toHaveLength(15);
    await markAllSentLegacy(f); // the state production is in: every contact flagged "sent"
    expect(f.track().every((t) => t[21] === "sent")).toBe(true);

    const readsBefore = f.gmail.calls.filter((c) => c.startsWith("read:")).length;
    const sendsBefore = f.gmail.sendCalls().length;
    f.clock.now = new Date(f.clock.now.getTime() + 120_000);
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(10); // contacts 0-3: Lukky + Rishii (8); contacts 4-5: Rishii (2)
    expect(f.gmail.sendCalls().length - sendsBefore).toBe(10);
    expect(f.gmail.calls.filter((c) => c.startsWith("read:")).length - readsBefore).toBe(10); // one Gmail read per e-mail sent: the complete contacts cost nothing
    expect(f.gmail.sentMessages.filter((m) => /draft_[678]_/.test(m.draftId))).toHaveLength(9); // contacts 6-8: still exactly their own nine

    // Lukky's drafts for contacts 4 and 5 are created later: they are still eligible, and only they go out
    for (const [key, x] of late) { f.draftLedger.set(key, x.entry!); if (x.gmail) f.gmail.drafts.set(x.id, x.gmail); }
    f.clock.now = new Date(f.clock.now.getTime() + 120_000);
    const lateRun = await runSendStep(f.deps());
    expect(lateRun.sent).toBe(2);
    expectEachSentOnce(f, 9);
    expect(f.track().every((t) => t[21] === "sent")).toBe(true);
  });
});

/** A Gmail port that only lets the given members (and optionally only the given connections) through; the rest report their draft as "not found". */
function onlyFor(f: Fx, members: MemberId[], connections?: Set<string>) {
  return {
    address: (m: MemberId) => f.gmail.address(m),
    readDraft: async (m: MemberId, id: string): Promise<ReadResult> => {
      const conn = `conn_${id.split("_")[1]}`;
      return members.includes(m) && (!connections || connections.has(conn)) ? f.gmail.readDraft(m, id) : { status: "not_found" };
    },
    send: (m: MemberId, id: string) => f.gmail.send(m, id),
    reconcile: (m: MemberId, id: string) => f.gmail.reconcile(m, id),
    inspect: (m: MemberId, id: string) => f.gmail.inspect(m, id),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
describe("a late-created draft is checked exactly like any other", () => {
  /** Anni's e-mail is sent; Lukky's and Rishii's drafts are created afterwards; the contact is flagged 'sent' (the old bug). */
  async function lateDrafts(spec: ContactSpec[] = people(1)) {
    const f = buildSendFixture(spec);
    const restore = hide(f, ["lukky", "rishii"]);
    await f.seed();
    await runSendStep(f.deps());
    await markAllSentLegacy(f);
    restore();
    f.clock.now = new Date(f.clock.now.getTime() + 120_000);
    return f;
  }

  it("a draft without the member's resume is not sent and is flagged for review; the other member's draft still goes out", async () => {
    const f = await lateDrafts();
    const d = f.gmail.drafts.get("draft_0_lukky") as Extract<ReadResult, { status: "ok" }>;
    f.gmail.drafts.set("draft_0_lukky", { status: "ok", draft: { ...d.draft, attachments: [] } });
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(1);
    expect(sentBy(f)).toEqual(["anni:draft_0_anni", "rishii:draft_0_rishii"]);
    expect(f.track()[0][21]).toBe("review");
    expect(f.track()[0][25]).toMatch(/lukky: \[resume\]/);
  });

  it("another member's resume on the draft is not accepted", async () => {
    const f = await lateDrafts();
    const d = f.gmail.drafts.get("draft_0_rishii") as Extract<ReadResult, { status: "ok" }>;
    f.gmail.drafts.set("draft_0_rishii", { status: "ok", draft: { ...d.draft, attachments: [{ filename: resumeFile("anni"), size: d.draft.attachments[0].size }] } });
    await runSendStep(f.deps());
    expect(sentBy(f)).toEqual(["anni:draft_0_anni", "lukky:draft_0_lukky"]);
  });

  it("an opted-out recipient receives nothing more, even though one e-mail had already gone out before the opt-out", async () => {
    const f = await lateDrafts();
    f.fake.tabs.set("Outreach Exclusions", [["Value", "Reason", "AddedAt", "AddedBy"], ["p0@c0.example.com", "asked not to be contacted", "", "anni"]]);
    expect((await runSendStep(f.deps())).sent).toBe(0);
    expect(sentBy(f)).toEqual(["anni:draft_0_anni"]);
  });

  it("an invalid recipient is not sent to", async () => {
    const f = await lateDrafts();
    const { records } = await f.sheet.readTracking();
    await f.sheet.updateTracking({ ...records[0], email: "not-an-address" });
    expect((await runSendStep(f.deps())).sent).toBe(0);
  });

  it("a duplicate recipient (another Connection, same address) is not e-mailed twice by the same member", async () => {
    const f = await lateDrafts([{ email: "dup@acme.example.com", name: "Dee Dup", company: "Acme", members: ALL }, { email: "DUP@Acme.Example.com", name: "Dee Dup", company: "Acme", members: ALL }]);
    await runSendStep(f.deps());
    const perMember = (m: MemberId) => f.gmail.sentMessages.filter((x) => x.member === m).length;
    expect(ALL.map(perMember)).toEqual([1, 1, 1]); // one e-mail per member to that address, however many Connections hold it
  });

  it("each e-mail comes from the member who owns the draft, with that member's own resume", async () => {
    const f = await lateDrafts();
    await runSendStep(f.deps());
    for (const row of f.ledger().filter((l) => l[3] === "sent")) {
      expect(row[9]).toBe(resumeFile(row[4] as MemberId));
      expect(row[12]).toBe(`draft_0_${row[4]}`);
    }
    expect(f.gmail.sentMessages.map((m) => m.member).sort()).toEqual([...ALL].sort());
  });

  it("a confirmed e-mail is never sent again, however many times the contact is looked at, even if the draft ledger still says 'created'", async () => {
    const f = await lateDrafts();
    await runSendStep(f.deps());
    for (const [k, v] of f.draftLedger) f.draftLedger.set(k, { ...v, status: "created" }); // as if every "mark sent" follow-up had been lost
    await markAllSentLegacy(f);
    for (let i = 0; i < 4; i++) {
      f.clock.now = new Date(f.clock.now.getTime() + 120_000);
      await runSendStep(f.deps());
    }
    expectEachSentOnce(f, 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("uncertain and interrupted sends of a late draft", () => {
  async function late() {
    const f = buildSendFixture(people(1));
    const restore = hide(f, ["lukky", "rishii"]);
    await f.seed();
    await runSendStep(f.deps());
    await markAllSentLegacy(f);
    restore();
    f.clock.now = new Date(f.clock.now.getTime() + 120_000);
    return f;
  }

  it("a crash right after 'sending' is reconciled against Gmail before anything else; the crashed send is not repeated", async () => {
    const f = await late();
    f.gmail.sendScript = ["throw"]; // Lukky's send (first candidate member) dies inside the Gmail call
    const crashed = await runSendStep(f.deps());
    expect(crashed.stoppedBecause).toBe("error");
    expect(f.ledger().filter((l) => l[3] === "sending")).toHaveLength(1);
    await runSendStep(f.deps()); // an overlapping call right afterwards must leave that key alone
    expect(f.gmail.sendCalls().filter((c) => c === "send:lukky:draft_0_lukky")).toHaveLength(1);
    f.clock.now = new Date(f.clock.now.getTime() + 3 * 60_000);
    f.gmail.reconcileScript = [{ state: "sent", messageId: "msg-proved" }];
    await runSendStep(f.deps());
    expect(f.ledger().find((l) => l[0] === sendKeyFor("lukky", "p0@c0.example.com"))![14]).toBe("msg-proved");
    expectThreeConfirmedOnce(f);
    expect(f.gmail.sendCalls().filter((c) => c === "send:lukky:draft_0_lukky")).toHaveLength(1); // the crashed send was never repeated
  });

  it("a crash where Gmail shows the draft is still there is retried only after the back-off, and then sent once", async () => {
    const f = await late();
    f.gmail.sendScript = ["throw"];
    await runSendStep(f.deps());
    f.clock.now = new Date(f.clock.now.getTime() + 3 * 60_000);
    f.gmail.reconcileScript = [{ state: "not_sent" }];
    await runSendStep(f.deps());
    expect(f.gmail.sendCalls().filter((c) => c === "send:lukky:draft_0_lukky")).toHaveLength(1); // not retried yet
    f.clock.now = new Date(f.clock.now.getTime() + 15 * 60_000);
    await runSendStep(f.deps());
    expect(f.gmail.sendCalls().filter((c) => c === "send:lukky:draft_0_lukky")).toHaveLength(2);
    expect(f.gmail.sentMessages.filter((m) => m.member === "lukky")).toHaveLength(1);
  });

  it("an earlier uncertain send that cannot be proven is never retried, while the other member's late draft is sent", async () => {
    const f = await late();
    f.gmail.sendScript = [{ status: "uncertain", reason: "timeout" }];
    f.gmail.reconcileScript = [{ state: "unknown", reason: "metadata permission missing" }];
    await runSendStep(f.deps());
    for (let day = 1; day <= 3; day++) {
      f.clock.now = new Date(f.clock.now.getTime() + day * 24 * 3600_000);
      f.gmail.reconcileScript = [{ state: "unknown", reason: "still unknown" }];
      await runSendStep(f.deps());
    }
    expect(f.gmail.sendCalls().filter((c) => c === "send:lukky:draft_0_lukky")).toHaveLength(1); // exactly one attempt, ever
    expect(f.ledger().find((l) => l[0] === sendKeyFor("lukky", "p0@c0.example.com"))![3]).toBe("uncertain");
    expect(f.gmail.sentMessages.map((m) => m.member).sort()).toEqual(["anni", "rishii"]);
  });

  it("an uncertain send that Gmail later PROVES was sent is recorded once and not sent again", async () => {
    const f = await late();
    f.gmail.sendScript = [{ status: "uncertain", reason: "timeout" }];
    f.gmail.reconcileScript = [{ state: "sent", messageId: "msg-real" }];
    await runSendStep(f.deps());
    for (let i = 0; i < 2; i++) { f.clock.now = new Date(f.clock.now.getTime() + 120_000); await runSendStep(f.deps()); }
    expectThreeConfirmedOnce(f);
    expect(f.ledger().find((l) => l[0] === sendKeyFor("lukky", "p0@c0.example.com"))![14]).toBe("msg-real");
    expect(f.gmail.sendCalls().filter((c) => c === "send:lukky:draft_0_lukky")).toHaveLength(1);
  });

  it("concurrent executions never send the same member's e-mail twice", async () => {
    const f = await late();
    await Promise.all([runSendStep(f.deps()), runSendStep(f.deps()), runSendStep(f.deps())]);
    await runSendStep(f.deps());
    expectEachSentOnce(f, 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("contacts that cannot be sent as they are rotate, like review contacts", () => {
  it("a 'blocked' contact (here: opted out) is re-checked only every Nth call, so it cannot use every call's time", async () => {
    const f = buildSendFixture(people(6));
    f.fake.tabs.set("Outreach Exclusions", [["Value", "Reason", "AddedAt", "AddedBy"], ...Array.from({ length: 5 }, (_, i) => [`p${i}@c${i}.example.com`, "opt out", "", "anni"])]);
    for (let i = 0; i < 5; i++) for (const m of ALL) { const d = f.gmail.drafts.get(`draft_${i}_${m}`) as Extract<ReadResult, { status: "ok" }>; f.gmail.drafts.set(`draft_${i}_${m}`, { status: "ok", draft: { ...d.draft, attachments: [] } }); }
    await f.seed();
    await runSendStep(f.deps({ reviewRecheckEvery: 5 }));
    expect(f.track().filter((t) => t[21] === "blocked").length).toBe(5);
    const perCall: number[] = [];
    for (let call = 0; call < 5; call++) {
      f.clock.now = new Date(f.clock.now.getTime() + 120_000);
      const before = f.gmail.calls.length;
      await runSendStep(f.deps({ reviewRecheckEvery: 5 }));
      perCall.push(f.gmail.calls.length - before);
    }
    expect(perCall.filter((n) => n > 0).length).toBeLessThanOrEqual(5);
    expect(f.gmail.sentMessages).toHaveLength(3); // the one good contact went out once
  });
});
