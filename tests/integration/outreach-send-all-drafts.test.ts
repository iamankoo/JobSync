/**
 * SEND EVERY JOBSYNC DRAFT (config sendAllDrafts / OUTREACH_SEND_ALL_DRAFTS, default OFF): the owner's explicit instruction that every draft JobSync created that carries the
 * member's OWN resume is sent, whether or not it passes the content checks. The tests pin down exactly what is relaxed and, as important, what is NOT.
 * In-memory spreadsheets and a MOCK Gmail port: nothing real is contacted and no e-mail is sent.
 */
import { describe, expect, it, vi } from "vitest";
import type { MemberId } from "@/config/members";
import { MEMBER_RESUME_FILES } from "@/config/resume-map";
import { DEFAULT_SEND_FIRST_AT, loadOutreachConfig } from "@/lib/outreach/config";
import { runOutreachCycle, sendFirstThreshold, type CycleDeps } from "@/lib/outreach/run";
import { runSendStep, type SendDeps } from "@/lib/outreach/send-workflow";
import { draftKeyFor } from "@/lib/outreach/sync";
import { newOutreachSpreadsheet, masterGrid, manyContacts } from "../helpers/outreach";
import { NOW, buildSendFixture, resumeFile } from "../helpers/send-fixture";

const ALL: MemberId[] = ["anni", "lukky", "rishii"];
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `p${i}@cp${i}.example.com`, name: `Pat Person${i}`, company: `Co${i}`, members: ALL }));
const draftOf = (i: number, m: MemberId) => `draft_${i}_${m}`;
const STATUS = 3, MEMBER = 4, ACCOUNT = 5, RESUME = 9;
const relaxed = (f: ReturnType<typeof buildSendFixture>): SendDeps => f.deps({ relaxContentChecks: true, reviewRecheckEvery: 1 });

type Fx = ReturnType<typeof buildSendFixture>;
function edit(f: Fx, i: number, m: MemberId, change: (d: import("@/lib/gmail/send").DraftReadback) => Partial<import("@/lib/gmail/send").DraftReadback>) {
  const cur = f.gmail.drafts.get(draftOf(i, m));
  if (cur?.status !== "ok") throw new Error("setup");
  f.gmail.drafts.set(draftOf(i, m), { status: "ok", draft: { ...cur.draft, ...change(cur.draft) } });
}
const flag = (f: Fx, i: number, m: MemberId, detail: string) => {
  const key = draftKeyFor(`conn_${i}`, m);
  f.draftLedger.set(key, { ...f.draftLedger.get(key)!, detail });
};
const longBody = (b: string, n = 400) => b.replace("I hope you're doing well.", "I hope you're doing well." + " word".repeat(n)); // inside the body: the word counter ignores the signature
const own = (m: MemberId) => Object.values(MEMBER_RESUME_FILES[m] ?? {}) as string[];

describe("default behaviour is unchanged: with the setting off, drafts that fail the content checks are NOT sent", () => {
  it("an over-long draft, a draft flagged for review and a stale resume size are all held, exactly as before", async () => {
    const f = buildSendFixture(people(3));
    await f.seed();
    edit(f, 0, "anni", (d) => ({ body: longBody(d.body) }));
    flag(f, 1, "anni", "review: company research unavailable");
    edit(f, 2, "anni", (d) => ({ attachments: [{ filename: d.attachments[0].filename, size: d.attachments[0].size + 5 }] }));
    const r = await runSendStep(f.deps());
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:anni"))).toHaveLength(0);
    expect(r.needsReview).toBeGreaterThanOrEqual(3);
    expect(f.ledger().filter((x) => x[MEMBER] === "anni")).toHaveLength(0);
  });
  it("the setting is off unless OUTREACH_SEND_ALL_DRAFTS=true", () => {
    expect(loadOutreachConfig({ OUTREACH_ENABLED: "true", OUTREACH_SPREADSHEET_ID: "x" } as unknown as NodeJS.ProcessEnv).sendAllDrafts).toBe(false);
    for (const v of ["", "false", "1", "yes", "TRUE"]) expect(loadOutreachConfig({ OUTREACH_SEND_ALL_DRAFTS: v } as unknown as NodeJS.ProcessEnv).sendAllDrafts).toBe(false);
    expect(loadOutreachConfig({ OUTREACH_SEND_ALL_DRAFTS: "true" } as unknown as NodeJS.ProcessEnv).sendAllDrafts).toBe(true);
  });
});

describe("with the setting ON: JobSync drafts that carry the member's own resume are sent whatever the content checks say", () => {
  it("sends an over-long draft, one flagged 'review:' for company research, one 'parked', one with a stale resume size, and one with unusual wording", async () => {
    const f = buildSendFixture(people(5));
    await f.seed();
    edit(f, 0, "anni", (d) => ({ body: longBody(d.body) })); // word limit
    flag(f, 1, "anni", "review: company research unavailable"); // content flag
    flag(f, 2, "anni", "parked: body is 190 words (limit 150)"); // parked by an earlier call
    edit(f, 3, "anni", (d) => ({ attachments: [{ filename: d.attachments[0].filename, size: d.attachments[0].size + 5 }] })); // a stale version of the member's own resume
    edit(f, 4, "anni", (d) => ({ body: d.body.replace(/Co4/g, "somewhere") })); // company name not mentioned
    const r = await runSendStep(relaxed(f));
    const sent = f.ledger().filter((x) => x[MEMBER] === "anni" && x[STATUS] === "sent");
    expect(sent).toHaveLength(5);
    expect(r.sent).toBe(15); // all three members, all five contacts
    // the recorded resume is the one really attached to the draft, and it is the member's own
    expect(sent.every((x) => own("anni").includes(String(x[RESUME])))).toBe(true);
  });

  it("sends from every member's own Gmail account with that member's own resume (Anni, Lukky and Rishii)", async () => {
    const f = buildSendFixture(people(4));
    await f.seed();
    for (let i = 0; i < 4; i++) for (const m of ALL) edit(f, i, m, (d) => ({ body: longBody(d.body, 300) }));
    await runSendStep(relaxed(f));
    for (const m of ALL) {
      const mine = f.ledger().filter((x) => x[MEMBER] === m && x[STATUS] === "sent");
      expect(mine).toHaveLength(4);
      expect(mine.every((x) => x[ACCOUNT] === f.gmail.addresses[m] && x[RESUME] === resumeFile(m))).toBe(true);
    }
    expect(new Set(f.gmail.sendCalls()).size).toBe(12);
  });

  it("a contact the usual rotation would skip as 'needs a person' is looked at on every call", async () => {
    const f = buildSendFixture(people(3));
    for (const t of f.tracking) { t.sendStatus = "review"; t.sendBlockReason = "[word_limit] body is 190 words (limit 150)"; }
    await f.seed();
    const r = await runSendStep(relaxed(f));
    expect(r.sent).toBe(9);
  });
});

describe("with the setting ON, what is still NEVER sent", () => {
  it("a draft without this member's resume: none attached, or only another member's, or another member's alongside it", async () => {
    const f = buildSendFixture(people(4));
    await f.seed();
    edit(f, 0, "anni", () => ({ attachments: [] }));
    edit(f, 1, "anni", () => ({ attachments: [{ filename: resumeFile("lukky"), size: 1000 }] })); // Lukky's resume on Anni's draft
    edit(f, 2, "anni", () => ({ attachments: [{ filename: "Aniket_Raj_SDE.pdf", size: 1000 }, { filename: resumeFile("rishii"), size: 1000 }] })); // own + a foreign one
    edit(f, 3, "anni", () => ({ attachments: [{ filename: "Random_Document.pdf", size: 1000 }] })); // not any member's resume
    await runSendStep(relaxed(f));
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:anni"))).toHaveLength(0);
    expect(f.ledger().filter((x) => x[MEMBER] === "anni")).toHaveLength(0);
  });

  it("a draft addressed to someone other than the contact, or one that mentions another member", async () => {
    const f = buildSendFixture(people(2));
    await f.seed();
    edit(f, 0, "lukky", () => ({ to: "someone.else@other.example.com" }));
    edit(f, 1, "lukky", (d) => ({ body: d.body + "\nPS: also see Aniket Raj's GitHub" }));
    await runSendStep(relaxed(f));
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:lukky"))).toHaveLength(0);
  });

  it("a message Gmail no longer has as a DRAFT (already sent by hand, trashed, or without labels)", async () => {
    const f = buildSendFixture(people(3));
    await f.seed();
    f.gmail.markSentOutside(draftOf(0, "rishii"));
    edit(f, 1, "rishii", () => ({ labelIds: ["TRASH"] }));
    edit(f, 2, "rishii", () => ({ labelIds: undefined }));
    await runSendStep(relaxed(f));
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:rishii"))).toHaveLength(0);
  });

  it("an opted-out or excluded recipient, an invalid address, and a Connection that is no longer 'Not Connected'/'Messaged'", async () => {
    const f = buildSendFixture(people(3));
    f.fake.tabs.set("Outreach Exclusions", [["Value", "Reason", "AddedAt", "AddedBy"], [people(3)[0].email, "asked not to be contacted", "", "anni"]]);
    f.tracking[1].email = "not-an-email";
    await f.seed();
    f.connections.set("conn_2", { ...f.connections.get("conn_2")!, status: "Replied" as never });
    const r = await runSendStep(relaxed(f));
    expect(r.sent).toBe(0);
    expect(f.gmail.sendCalls()).toHaveLength(0);
  });

  it("anything already sent: no duplicates, ever, however many calls", async () => {
    const f = buildSendFixture(people(3));
    await f.seed();
    await runSendStep(relaxed(f));
    for (let k = 1; k <= 3; k++) { f.clock.now = new Date(NOW.getTime() + k * 3 * 60_000); await runSendStep(relaxed(f)); }
    expect(f.gmail.sendCalls()).toHaveLength(9);
    expect(new Set(f.gmail.sendCalls()).size).toBe(9);
  });

  it("a recipient the same member has already e-mailed from another record, and a sent_outside recipient", async () => {
    const f = buildSendFixture([...people(1), { ...people(1)[0], name: "Pat Person0 again" }]); // the same address twice
    await f.seed();
    await runSendStep(relaxed(f));
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:anni"))).toHaveLength(1); // one e-mail per member per recipient
  });

  it("the final Gmail label check right before the send still applies (a draft sent by hand a moment after the readback)", async () => {
    const f = buildSendFixture(people(1));
    await f.seed();
    f.gmail.onRead = (m, id) => { if (m === "anni") f.gmail.markSentOutside(id); };
    await runSendStep(relaxed(f));
    expect(f.gmail.sendCalls().filter((c) => c.startsWith("send:anni"))).toHaveLength(0);
    expect(f.ledger().find((x) => x[MEMBER] === "anni")![STATUS]).toBe("sent_outside");
  });
});

describe("the mode stays on until NO JobSync draft is left", () => {
  const cfg = (o: Record<string, string>) => loadOutreachConfig({ OUTREACH_ENABLED: "true", OUTREACH_SPREADSHEET_ID: "x", ...o } as unknown as NodeJS.ProcessEnv);
  it("the send-first threshold is 1 with the setting on, the configured 50 otherwise, and 0 once the runner has suspended the mode", () => {
    expect(sendFirstThreshold(cfg({}))).toBe(DEFAULT_SEND_FIRST_AT);
    expect(sendFirstThreshold(cfg({ OUTREACH_SEND_ALL_DRAFTS: "true" }))).toBe(1);
    expect(sendFirstThreshold({ ...cfg({ OUTREACH_SEND_ALL_DRAFTS: "true" }), sendFirstSuspended: true })).toBe(0);
    expect(sendFirstThreshold({ ...cfg({}), sendFirstSuspended: true })).toBe(0);
  });
  it("one saved draft is enough to run send-first when every draft is to be sent; with the setting off one draft changes nothing", async () => {
    const o = newOutreachSpreadsheet(masterGrid(manyContacts(3)));
    await o.sheet.ensureTabs();
    const make = (c: ReturnType<typeof cfg>): { deps: CycleDeps; send: ReturnType<typeof vi.fn> } => {
      const send = vi.fn(async () => ({ status: "ran" as const, sent: 0, blocked: 0, needsReview: 0, failed: 0, waiting: 0, duplicatesPrevented: 0, reconciled: 0, stoppedBecause: "none" as const, errors: [] }));
      return { send, deps: { config: c, sheet: o.sheet, connections: { listFresh: async () => [], create: async () => { throw new Error("no import"); } }, ledger: async () => new Map(), connected: async () => ALL, send, savedDrafts: async () => 1, gate: true, now: () => NOW, timezone: "Asia/Kolkata" } };
    };
    const on = make(cfg({ OUTREACH_SEND_ALL_DRAFTS: "true" }));
    expect((await runOutreachCycle(on.deps)).mode).toBe("send-first");
    const off = make(cfg({}));
    expect((await runOutreachCycle(off.deps)).mode).toBe("normal");
  });
  it("the real wiring relaxes the content checks and looks at every contact on every call only when the setting is on, and counts parked drafts too", async () => {
    const { readFileSync } = await import("node:fs");
    const run = readFileSync("src/lib/outreach/run.ts", "utf8");
    expect(run).toMatch(/reviewRecheckEvery: config\.sendAllDrafts \? 1 : REVIEW_RECHECK_EVERY/);
    expect(run).toMatch(/relaxContentChecks: config\.sendAllDrafts/);
    expect(run).toMatch(/counted\.byMember\[m\] \+ \(config\.sendAllDrafts \? counted\.parkedByMember\[m\] : 0\)/);
  });
});
