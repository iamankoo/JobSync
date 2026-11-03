/**
 * The Draft / Sent counters, driven by the REAL send workflow, the REAL draft ledger (NF_Drafts) and the REAL Send Ledger code over
 * in-memory sheets. Gmail is a scripted mock; nothing is sent anywhere.
 *
 * RULE under test: Sent counts ONLY e-mails JobSync's automated workflow sent (Send Ledger row "sent" with Gmail's message id).
 * Hand-sent JobSync drafts, outside e-mails and GMAIL_TRACK_SENT never add to it. Draft behaves as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), getSession: vi.fn() }));

import { GET as countersRoute } from "@/app/api/gmail/counters/route";
import type { MemberId } from "@/config/members";
import { getSession } from "@/lib/auth/session";
import { draftListFor } from "@/lib/gmail/draft-list";
import { countersFor, draftsWithSent, setSendLedgerReaderForTesting } from "@/lib/gmail/sent-counter";
import { readDraftLedger, recordDraft } from "@/lib/gmail/store";
import { setSheetsClientForTesting } from "@/lib/google-sheets/client";
import { resetMembersCache } from "@/lib/google-sheets/members-service";
import { invalidateTableCache } from "@/lib/google-sheets/table";
import { runSendStep, type SendDeps } from "@/lib/outreach/send-workflow";
import { FakeSheets } from "../helpers/fake-sheets";
import { buildSendFixture } from "../helpers/send-fixture";

let prod: FakeSheets;
let f: ReturnType<typeof buildSendFixture>;
const AT = "2026-11-06T05:00:00.000Z";
const as = (m: MemberId | null) => vi.mocked(getSession).mockResolvedValue(m ? { memberId: m, expiresAt: 9_999_999_999 } : null);

/** Send deps whose draft-ledger port is the REAL NF_Drafts ledger on the production-shaped fake sheet. */
const deps = (over: Partial<SendDeps> = {}): SendDeps =>
  f.deps({
    drafts: {
      snapshot: async () => new Map([...(await readDraftLedger({ fresh: true })).entries()].map(([k, v]) => [k, { status: v.status, detail: v.detail, gmailDraftId: v.gmailDraftId, ...(v.threadId ? { threadId: v.threadId } : {}) }])),
      markSent: async (m, connectionId) => {
        const cur = (await readDraftLedger({ fresh: true })).get(`contact:${connectionId}:${m}`);
        if (cur) await recordDraft({ ...cur, status: "sent", checkedAt: AT });
      },
    },
    ...over,
  });

/** The Send Ledger exactly as the application reads it. */
const realLedger = async () => (await f.sheet.readSendLedger()).records.map((r) => ({ member: r.member, sendKey: r.sendKey, connectionId: r.connectionId, status: r.status, gmailMessageId: r.gmailMessageId }));
const row = (member: string, connectionId: string, status: string, gmailMessageId = "msg-1", sendKey = `${connectionId}@x.example.com`) => ({ member, sendKey, connectionId, status, gmailMessageId });

const draftRow = (connId: string, m: MemberId, status = "created", detail = "", draftId = `gd-${connId}-${m}`) => [`contact:${connId}:${m}`, m, "contact", connId, draftId, status, AT, detail, `t-${connId}`, ""];
const connRow = (id: string, owner: MemberId, name: string, company: string, email: string) => [id, owner, name, company, "HR", "", "", "", "", "Not Connected", AT, AT, email];

beforeEach(async () => {
  prod = new FakeSheets().seedMembers();
  setSheetsClientForTesting(prod);
  resetMembersCache();
  invalidateTableCache();
  f = buildSendFixture([
    { email: "jane@acme.example.com", name: "Jane Doe", company: "Acme", owner: "anni" },
    { email: "raj@bolt.example.com", name: "Raj Rao", company: "Bolt", owner: "lukky" },
  ]);
  await f.seed();
  // Production-side rows: Connections, plus the fan-out of drafts (every member has a draft for every contact).
  for (const [id, c] of f.connections) prod.rows("Connections").push(connRow(id, c.memberId, c.name, c.company ?? "", c.email ?? ""));
  for (const [id, c] of f.connections) {
    for (const m of ["anni", "lukky", "rishii"] as const) {
      const own = m === c.memberId ? f.draftLedger.get(`contact:${id}:${m}`) : undefined; // the owner's draft is the one the mock Gmail knows
      prod.rows("NF_Drafts").push(draftRow(id, m, "created", own?.detail ?? "", own?.gmailDraftId));
    }
  }
  invalidateTableCache();
  setSendLedgerReaderForTesting(realLedger);
});
afterEach(() => {
  setSendLedgerReaderForTesting(undefined);
  setSheetsClientForTesting(null);
  vi.mocked(getSession).mockReset();
});

describe("1. a successful JobSync send increments Sent by exactly one", () => {
  it("Draft goes 1 -> 0 and Sent 0 -> 1 for the sending member, once; the others are unchanged", async () => {
    expect(await countersFor("anni")).toEqual({ drafted: 2, sent: 0 }); // 2 contacts, anni has a draft for each
    const r = await runSendStep(deps({ limits: { perMemberDaily: 10, globalDaily: 25, perRun: 1 } }));
    expect(r.sent).toBe(1);
    expect(f.gmail.sendCalls()).toEqual(["send:anni:draft_0_anni"]);
    expect(await countersFor("anni")).toEqual({ drafted: 1, sent: 1 });
    expect(await countersFor("lukky")).toEqual({ drafted: 2, sent: 0 }); // lukky's own send has not happened
    expect(await countersFor("rishii")).toEqual({ drafted: 2, sent: 0 });
  });

  it("running the workflow and the counter again does not add a second Sent for the same contact", async () => {
    await runSendStep(deps());
    await runSendStep(deps());
    await runSendStep(deps());
    // each member sent their OWN contact once; each still holds the fan-out draft for the other member's contact (never sent)
    expect(await countersFor("anni")).toEqual({ drafted: 1, sent: 1 });
    expect(await countersFor("lukky")).toEqual({ drafted: 1, sent: 1 });
    expect(await countersFor("rishii")).toEqual({ drafted: 2, sent: 0 });
    expect(f.gmail.sendCalls()).toHaveLength(2);
  });
});

describe("2. creating drafts does not increment Sent", () => {
  it("more drafts raise Draft only", async () => {
    const before = await countersFor("anni");
    prod.rows("Connections").push(connRow("conn_new", "anni", "New Person", "NewCo", "new@newco.example.com"));
    prod.rows("NF_Drafts").push(draftRow("conn_new", "anni"));
    invalidateTableCache();
    expect(await countersFor("anni")).toEqual({ drafted: before.drafted + 1, sent: before.sent });
  });
});

describe("3. failed or uncertain sends do not increment Sent", () => {
  it("rate limit, auth failure and rejection: no Sent, the draft stays a draft", async () => {
    for (const script of [{ status: "rate_limited" as const }, { status: "auth_failed" as const, reason: "x" }, { status: "rejected" as const, reason: "bad" }]) {
      f.gmail.sendScript = [script];
      f.clock.now = new Date(f.clock.now.getTime() + 24 * 3600_000);
      await runSendStep(deps({ limits: { perMemberDaily: 10, globalDaily: 25, perRun: 1 } }));
      expect(await countersFor("anni"), script.status).toEqual({ drafted: 2, sent: 0 });
    }
  });

  it("an uncertain result that cannot be proven: not counted (and not resent)", async () => {
    f.gmail.sendScript = [{ status: "uncertain", reason: "timeout" }];
    f.gmail.reconcileScript = [{ state: "unknown", reason: "metadata permission missing" }];
    await runSendStep(deps({ limits: { perMemberDaily: 10, globalDaily: 25, perRun: 1 } }));
    expect(await countersFor("anni")).toEqual({ drafted: 2, sent: 0 });
    expect((await f.sheet.readSendLedger()).records[0].status).toBe("uncertain");
  });

  it("an uncertain result that Gmail later PROVES sent is counted exactly once", async () => {
    f.gmail.sendScript = [{ status: "uncertain", reason: "timeout" }];
    f.gmail.reconcileScript = [{ state: "sent", messageId: "msg-proven" }];
    await runSendStep(deps({ limits: { perMemberDaily: 10, globalDaily: 25, perRun: 1 } }));
    expect(await countersFor("anni")).toEqual({ drafted: 1, sent: 1 });
    await runSendStep(deps({ limits: { perMemberDaily: 10, globalDaily: 25, perRun: 1 } }));
    expect((await countersFor("anni")).sent).toBe(1);
  });
});

describe("4. nothing is counted twice, whichever records mirror the send", () => {
  it("send recorded in the Send Ledger, the draft ledger AND the Connection -> one; draft-ledger update lost -> still one; tracker later catches up -> still one", async () => {
    await runSendStep(deps({ limits: { perMemberDaily: 10, globalDaily: 25, perRun: 1 } }));
    expect(await countersFor("anni")).toEqual({ drafted: 1, sent: 1 }); // all JobSync records agree
    // simulate the follow-up draft-ledger update having been lost
    const r = prod.rows("NF_Drafts").find((x) => x[0] === "contact:conn_0:anni")!;
    r[5] = "created";
    invalidateTableCache();
    const list = await draftsWithSent("anni");
    expect([list.drafted, list.sent]).toEqual([1, 1]);
    expect(list.items.find((i) => i.draftKey === "contact:conn_0:anni")!.status).toBe("Sent"); // shown as sent, not as a waiting draft
    r[5] = "sent"; // the existing tracker catches up later
    invalidateTableCache();
    expect(await countersFor("anni")).toEqual({ drafted: 1, sent: 1 });
    for (let i = 0; i < 5; i++) expect((await countersFor("anni")).sent).toBe(1);
  });

  it("duplicate Send Ledger rows for one recipient (a retry, a superseded claim) count that recipient once", async () => {
    setSendLedgerReaderForTesting(async () => [row("anni", "conn_0", "sent", "m1", "jane@acme.example.com"), row("anni", "conn_0", "sent", "m2", "jane@acme.example.com"), row("anni", "conn_0", "superseded", "", "jane@acme.example.com")]);
    expect((await countersFor("anni")).sent).toBe(1);
  });

  it("the same contact sent by automation AND marked sent in the draft ledger -> one", async () => {
    await runSendStep(deps({ limits: { perMemberDaily: 10, globalDaily: 25, perRun: 1 } }));
    expect(prod.rows("NF_Drafts").find((x) => x[0] === "contact:conn_0:anni")![5]).toBe("sent");
    expect((await countersFor("anni")).sent).toBe(1);
  });
});

describe("5. only automated sends count: hand-sent drafts and outside e-mail are excluded", () => {
  it("a JobSync draft the member sent BY HAND (draft ledger 'sent') is NOT counted as Sent; it simply stops being a waiting draft", async () => {
    prod.rows("NF_Drafts").find((x) => x[0] === "contact:conn_1:anni")![5] = "sent";
    invalidateTableCache();
    expect(await countersFor("anni")).toEqual({ drafted: 1, sent: 0 });
  });

  it("GMAIL_TRACK_SENT=true does not change that: manually sent drafts still never count", async () => {
    vi.stubEnv("GMAIL_TRACK_SENT", "true");
    try {
      prod.rows("NF_Drafts").find((x) => x[0] === "contact:conn_1:anni")![5] = "sent";
      prod.rows("NF_Drafts").find((x) => x[0] === "contact:conn_0:anni")![5] = "sent";
      invalidateTableCache();
      expect(await countersFor("anni")).toEqual({ drafted: 0, sent: 0 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the counter never reads Gmail or the draft-ledger as a source: a member's unrelated e-mail cannot appear", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("the counter must not call Gmail"); });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      expect(await countersFor("anni")).toEqual({ drafted: 2, sent: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a send counts only when the ledger status is 'sent' AND Gmail's message id is recorded", async () => {
    setSendLedgerReaderForTesting(async () => [
      ...["claimed", "sending", "uncertain", "failed_transient", "failed_permanent", "superseded", "released", "needs_review"].map((status, i) => row("anni", `conn_x${i}`, status)),
      row("anni", "conn_noid", "sent", ""),
      row("anni", "conn_blank", "sent", "   "),
    ]);
    expect((await countersFor("anni")).sent).toBe(0);
    setSendLedgerReaderForTesting(async () => [row("anni", "conn_ok", "sent", "gmail-id-9")]);
    expect((await countersFor("anni")).sent).toBe(1);
  });

  it("rows of other members never count for me", async () => {
    setSendLedgerReaderForTesting(async () => [row("lukky", "conn_0", "sent")]);
    expect(await countersFor("anni")).toEqual({ drafted: 2, sent: 0 });
    expect((await countersFor("lukky")).sent).toBe(1);
  });

  it("without an Outreach Database (no Send Ledger) nothing automated has been sent: Sent is 0, Draft is unchanged", async () => {
    setSendLedgerReaderForTesting(null);
    prod.rows("NF_Drafts").find((x) => x[0] === "contact:conn_0:anni")![5] = "sent"; // even a hand-sent draft
    invalidateTableCache();
    expect(await countersFor("anni")).toEqual({ drafted: 1, sent: 0 });
  });

  it("the Draft counter behaves exactly as before: created drafts count, deleted / sent / failed ones do not", async () => {
    const set = (key: string, status: string) => { prod.rows("NF_Drafts").find((x) => x[0] === key)![5] = status; invalidateTableCache(); };
    expect((await countersFor("rishii")).drafted).toBe(2);
    set("contact:conn_0:rishii", "deleted");
    expect((await countersFor("rishii")).drafted).toBe(1);
    set("contact:conn_1:rishii", "skipped_unauthorized");
    expect((await countersFor("rishii")).drafted).toBe(0);
  });
});

describe("6. page refresh and background reconciliation show the correct count", () => {
  const call = (q = "") => countersRoute(new Request(`http://localhost/api/gmail/counters${q}`, { headers: { host: "localhost" } }));

  it("the endpoint (what the page asks on load and every 15 s) reflects a confirmed send as soon as the ledger does, and a refresh shows the same", async () => {
    as("anni");
    expect((await (await call()).json()).data).toMatchObject({ drafted: 2, sent: 0, memberId: "anni" });
    await runSendStep(deps({ limits: { perMemberDaily: 10, globalDaily: 25, perRun: 1 } }));
    expect((await (await call()).json()).data).toMatchObject({ drafted: 1, sent: 1 });
    invalidateTableCache();
    expect((await (await call()).json()).data).toMatchObject({ drafted: 1, sent: 1 });
  });

  it("an interrupted send is reconciled by the SEND workflow's own cron pass: only then does the (proven, message-id-carrying) send appear", async () => {
    f.gmail.sendScript = ["throw"]; // the process dies after submitting: ledger says 'sending'
    await runSendStep(deps({ limits: { perMemberDaily: 10, globalDaily: 25, perRun: 1 } }));
    as("anni");
    expect((await (await call()).json()).data).toMatchObject({ drafted: 2, sent: 0 }); // not counted while unconfirmed
    f.clock.now = new Date(f.clock.now.getTime() + 5 * 60_000);
    f.gmail.reconcileScript = [{ state: "sent", messageId: "msg-found" }];
    await runSendStep(deps({ limits: { perMemberDaily: 10, globalDaily: 25, perRun: 1 } })); // the next cron pass reconciles
    expect((await (await call()).json()).data).toMatchObject({ drafted: 1, sent: 1 });
    await runSendStep(deps());
    expect((await (await call()).json()).data.sent).toBe(1);
  });

  it("a hand-sent draft flipping to 'sent' in the draft ledger changes Draft only, never Sent", async () => {
    as("lukky");
    expect((await (await call()).json()).data).toMatchObject({ drafted: 2, sent: 0 });
    prod.rows("NF_Drafts").find((x) => x[0] === "contact:conn_0:lukky")![5] = "sent";
    invalidateTableCache();
    expect((await (await call()).json()).data).toMatchObject({ drafted: 1, sent: 0 });
  });

  it("the endpoint does not call Gmail", async () => {
    const spy = vi.fn(async () => { throw new Error("no Gmail calls from the counter endpoint"); });
    vi.stubGlobal("fetch", spy);
    try {
      as("anni");
      expect((await call()).status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("7. member-specific counts and admin permissions", () => {
  const call = (q = "") => countersRoute(new Request(`http://localhost/api/gmail/counters${q}`, { headers: { host: "localhost" } }));
  beforeEach(async () => {
    await runSendStep(deps()); // anni sends conn_0, lukky sends conn_1
  });

  it("a member sees only their own counts", async () => {
    as("lukky");
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ memberId: "lukky", sent: 1 });
  });

  it("a non-admin cannot read another member's counts (explicitly or by naming themself in the query)", async () => {
    as("lukky");
    const other = await call("?member=anni");
    expect(other.status).toBe(403);
    expect((await other.json()).error.code).toBe("forbidden");
    expect((await call("?member=lukky")).status).toBe(200);
    as("rishii");
    expect((await call("?member=lukky")).status).toBe(403);
  });

  it("the administrator (Anni) may read any member's counts; an unknown member is rejected", async () => {
    as("anni");
    expect((await (await call("?member=lukky")).json()).data).toMatchObject({ memberId: "lukky", sent: 1 });
    expect((await (await call("?member=rishii")).json()).data).toMatchObject({ memberId: "rishii", sent: 0 });
    expect((await call("?member=mallory")).status).toBe(400);
  });

  it("signed-out requests get 401", async () => {
    as(null);
    expect((await call()).status).toBe(401);
  });

  it("each member's Draft list contains only their own drafts", async () => {
    const l = await draftListFor("rishii");
    expect(l.items.every((i) => i.draftKey.endsWith(":rishii"))).toBe(true);
  });
});
