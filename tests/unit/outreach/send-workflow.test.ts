/**
 * The send workflow against scripted MOCK ports and an in-memory Outreach Database. Nothing here contacts Gmail or sends mail.
 */
import { describe, expect, it } from "vitest";
import type { MemberId } from "@/config/members";
import { runSendStep } from "@/lib/outreach/send-workflow";
import { computeCounters } from "@/lib/outreach/sync";
import { SENDING_ENABLED } from "@/lib/outreach/types";
import { NOW, buildSendFixture, draftBody, resumeFile } from "../../helpers/send-fixture";

const ONE = [{ email: "jane@acme.example.com", name: "Jane Doe", company: "Acme" }];
// tracking columns: 21 SendStatus, 25 SendBlockReason, 26 SentBy, 27 GmailAccount, 28 GmailMessageId, 29 ResumeSent, 30 SendAttempts
// ledger columns: 3 Status, 4 Member, 9 ResumeFile, 14 GmailMessageID, 17 NotBefore, 19 SentDay, 20 Reason, 21 History

describe("the gate", () => {
  it("the code-level switch is open, but the workflow still refuses when it is handed a closed gate", () => {
    expect(SENDING_ENABLED).toBe(true);
  });

  it("with the gate closed the workflow does nothing at all (no Gmail call, no sheet write)", async () => {
    const f = buildSendFixture(ONE);
    await f.seed();
    const before = JSON.stringify([...f.fake.tabs.entries()]);
    const r = await runSendStep(f.deps({ gate: false }));
    expect(r.status).toBe("disabled");
    expect(f.gmail.calls).toEqual([]);
    expect(JSON.stringify([...f.fake.tabs.entries()])).toBe(before);
  });
});

describe("A: a fully validated email is sent, confirmed, recorded and counted", () => {
  it("sends the OWNER's verified draft from the owner's mailbox, once, and records everything", async () => {
    const f = buildSendFixture([{ email: "jane@acme.example.com", name: "Jane Doe", company: "Acme", owner: "lukky" }]);
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ status: "ran", sent: 1, errors: [] });
    expect(f.gmail.sendCalls()).toEqual(["send:lukky:draft_0_lukky"]);
    const [ledger] = f.ledger();
    expect(ledger[3]).toBe("sent");
    expect(ledger.slice(4, 6)).toEqual(["lukky", "lakshya@gmail.test"]);
    expect(ledger[9]).toBe("Lakshya_SDE.pdf");
    expect(ledger[14]).toBe("msg-1");
    expect(ledger[19]).toBe("2026-11-06");
    expect(ledger[21]).toMatch(/claimed \(attempt 1\).*sending.*sent \(confirmed by Gmail\); message msg-1/);
    const [t] = f.track();
    expect([t[21], t[26], t[27], t[28], t[29], t[30]]).toEqual(["sent", "lukky", "lakshya@gmail.test", "msg-1", "Lakshya_SDE.pdf", "1"]);
    expect(f.calls.markSent).toEqual(["lukky:conn_0"]);
    expect(f.calls.markMessaged).toEqual(["conn_0"]);
    expect(f.connections.get("conn_0")!.status).toBe("Messaged");
  });

  it("counters come from the confirmed ledger row", async () => {
    const f = buildSendFixture(ONE);
    await f.seed();
    await runSendStep(f.deps());
    const { records } = await f.sheet.readTracking();
    const { records: ledger } = await f.sheet.readSendLedger();
    const c = computeCounters(records, "2026-11-06", 0, { ledger });
    expect(c).toMatchObject({ sentToday: 1, sentTodayByMember: { anni: 1, lukky: 0, rishii: 0 }, emailsSent: 1, failedSends: 0 });
  });

  it("a second run (cron retry) sends nothing more", async () => {
    const f = buildSendFixture(ONE);
    await f.seed();
    await runSendStep(f.deps());
    const r2 = await runSendStep(f.deps());
    expect(r2.sent).toBe(0);
    expect(f.gmail.sendCalls()).toHaveLength(1);
    expect(f.ledger()).toHaveLength(1);
  });

  it("two concurrent cron executions send the same contact exactly once", async () => {
    const f = buildSendFixture(ONE);
    await f.seed();
    const [a, b] = await Promise.all([runSendStep(f.deps()), runSendStep(f.deps())]);
    expect(f.gmail.sendCalls()).toHaveLength(1);
    expect(a.sent + b.sent).toBe(1);
    const rows = f.ledger();
    expect(rows.filter((r) => r[3] === "sent")).toHaveLength(1);
    expect(rows.every((r) => ["sent", "superseded"].includes(r[3]))).toBe(true);
  });

  it("many contacts: the per-run limit stops the run after N sends", async () => {
    const f = buildSendFixture(Array.from({ length: 6 }, (_, i) => ({ email: `p${i}@c${i}.example.com`, name: `Pat Person${i}`, company: `Co${i}` })), { perRun: 3, globalDaily: 50, perMemberDaily: 50 });
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ sent: 3, stoppedBecause: "per-run-limit" });
    expect(f.gmail.sendCalls()).toHaveLength(3);
  });
});

describe("the fourteen validations: any failure means NOT sent", () => {
  const specs = [{ email: "jane@acme.example.com", name: "Jane Doe", company: "Acme" }];
  const run = async (mutate: (f: ReturnType<typeof buildSendFixture>) => void | Promise<void>, limits = {}) => {
    const f = buildSendFixture(specs, limits);
    await mutate(f);
    await f.seed();
    const r = await runSendStep(f.deps());
    return { f, r, status: f.track()[0]?.[21], reason: f.track()[0]?.[25] ?? "" };
  };
  const notSent = (x: Awaited<ReturnType<typeof run>>) => {
    expect(x.f.gmail.sendCalls()).toEqual([]);
    expect(x.f.ledger().filter((r) => r[3] === "sent")).toEqual([]);
  };

  it("1 valid e-mail", async () => {
    const x = await run((f) => { f.tracking[0].email = "not-an-address"; });
    notSent(x);
    expect(x.reason).toMatch(/\[valid_email\]/);
  });
  it("2 eligible for outreach (not in the Outreach Database / ineligible)", async () => {
    const x = await run((f) => { f.tracking[0].contactId = "HRC-DEADBEEF0000"; });
    notSent(x);
    expect(x.reason).toMatch(/\[eligible\]/);
  });
  it("3 has a Connection (and it is still Not Connected)", async () => {
    const x = await run((f) => { f.connections.clear(); });
    notSent(x);
    expect(x.reason).toMatch(/\[connection\]/);
    const y = await run((f) => { f.connections.set("conn_0", { ...f.connections.get("conn_0")!, status: "Reply" }); });
    notSent(y);
    expect(y.reason).toMatch(/\[not_already_received\].*Reply/);
  });
  it("4 the tracked owner is the Connection's owner", async () => {
    const x = await run((f) => { f.tracking[0].ownerMemberId = "rishii"; });
    notSent(x);
    expect(x.reason).toMatch(/\[owner\]/);
  });
  it("5 the member's Gmail identity is connected", async () => {
    const x = await run((f) => { f.gmail.addresses.anni = null; });
    notSent(x);
    expect(x.reason).toMatch(/\[member_identity\].*not connected/);
  });
  it("6 a personalised email exists (waiting for the draft is not an error)", async () => {
    const x = await run((f) => { f.draftLedger.clear(); });
    notSent(x);
    expect(x.status).toBe("pending");
    expect(x.reason).toMatch(/\[email_generated\]/);
  });
  it("7 the information is supported (greeting, company, role, signature, no other member)", async () => {
    const bad = async (edit: (b: string) => string, re: RegExp) => {
      const x = await run((f) => { const d = f.gmail.drafts.get("draft_0_anni") as { draft: { body: string } }; d.draft.body = edit(d.draft.body); });
      notSent(x);
      expect(x.status).toBe("review");
      expect(x.reason).toMatch(re);
    };
    await bad((b) => b.replace("Dear Jane,", "Dear Hiring Team,"), /greeting should be "Dear Jane,"/);
    await bad((b) => b.replaceAll("Acme", "Zenith"), /company name is not mentioned/);
    {
      const x = await run((f) => { const d = (f.gmail.drafts.get("draft_0_anni") as { draft: { body: string; subject: string } }).draft; d.body = d.body.replaceAll("Software Engineer", "Chef"); d.subject = d.subject.replace("Software Engineer", "Chef"); });
      notSent(x);
      expect(x.status).toBe("review");
      expect(x.reason).toMatch(/target role "Software Engineer" is not stated/);
    }
    await bad((b) => b.replace("{{", "").replace("opportunity", "{{opportunity}}"), /placeholder/);
    await bad((b) => b.replaceAll("Aniket Raj", "Someone Else"), /signature does not carry/);
    await bad((b) => b + "\nP.S. Lakshya Singh says hi", /another member/);
  });
  it("8 the 150-word limit", async () => {
    const x = await run((f) => { const d = f.gmail.drafts.get("draft_0_anni") as { draft: { body: string } }; d.draft.body = d.draft.body.replace("Best regards", "word ".repeat(150) + "\n\nBest regards"); });
    notSent(x);
    expect(x.reason).toMatch(/\[word_limit\].*limit 150/);
  });
  it("9 the recipient has not already received outreach (a member sent a draft by hand)", async () => {
    const x = await run((f) => { f.draftLedger.set("contact:conn_0:rishii", { status: "sent", detail: "", gmailDraftId: "d" }); });
    notSent(x);
    expect(x.reason).toMatch(/rishii already sent/);
  });
  it("10 not opted out / excluded (by address or by domain)", async () => {
    for (const value of ["jane@acme.example.com", "@acme.example.com", "example.com"]) {
      const x = await run((f) => { f.fake.tabs.set("Outreach Exclusions", [["Value", "Reason", "AddedAt", "AddedBy"], [value, "asked not to be contacted", "", "anni"]]); });
      notSent(x);
      expect(x.reason, value).toMatch(/\[not_excluded\].*asked not to be contacted/);
    }
  });
  it("11 no previous successful send for this outreach/contact (tracking says sent, or the ledger does)", async () => {
    const x = await run((f) => { f.tracking[0].sendStatus = "sent"; });
    notSent(x);
    expect(x.status).toBe("sent"); // already done: not a candidate at all
    const y = await run(async (f) => {
      await f.sheet.ensureTabs();
      await f.sheet.appendSendRecord({ row: 0, sendKey: "jane@acme.example.com", contactId: f.tracking[0].contactId, claimId: "earlier", status: "sent", member: "anni", gmailAccount: "a@b", connectionId: "conn_0", company: "Acme", role: "Software Engineer", resumeFile: "x.pdf", resumeSha256: "", resumeBytes: 1, draftId: "d", threadId: "", gmailMessageId: "m-old", wordCount: 90, attempts: 1, notBefore: "", sentAt: "2026-11-01T00:00:00.000Z", sentDay: "2026-11-01", reason: "", history: "", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }, 2);
    });
    expect(y.f.gmail.sendCalls()).toEqual([]);
    expect(y.reason).toMatch(/\[no_prior_send\] a message to this recipient was already sent successfully/);
  });
  it("12 the member's resume is available and passes attachment validation (B: not sent, flagged for review)", async () => {
    for (const mode of ["unmapped", "missing"] as const) {
      const x = await run((f) => f.setResume(mode));
      notSent(x);
      expect(x.status).toBe("review");
      expect(x.reason).toMatch(/\[resume\] resume unavailable/);
    }
    const wrongSize = await run((f) => f.setResume("wrong_size"));
    notSent(wrongSize);
    expect(wrongSize.reason).toMatch(/\[resume\].*bytes, the member's resume is 7 bytes/);
    const wrongName = await run((f) => { (f.gmail.drafts.get("draft_0_anni") as { draft: { attachments: { filename: string }[] } }).draft.attachments[0].filename = "Lakshya_SDE.pdf"; });
    notSent(wrongName);
    expect(wrongName.reason).toMatch(/attached file is "Lakshya_SDE.pdf", expected "Aniket_Raj_SDE.pdf"/);
    const none = await run((f) => { (f.gmail.drafts.get("draft_0_anni") as { draft: { attachments: unknown[] } }).draft.attachments = []; });
    notSent(none);
    expect(none.reason).toMatch(/expected exactly one attachment, found 0/);
  });
  it("12b a draft the pipeline already flagged for review (no resume) is never sent", async () => {
    const x = await run((f) => { f.draftLedger.set("contact:conn_0:anni", { status: "created", detail: "review: no usable resume (x); no attachment", gmailDraftId: "draft_0_anni" }); });
    notSent(x);
    expect(x.status).toBe("review");
    expect(x.reason).toMatch(/\[resume\] no usable resume/);
  });
  it("13 Gmail authorisation is valid", async () => {
    const x = await run((f) => { f.gmail.drafts.set("draft_0_anni", { status: "no_access", access: "reauth_required" }); });
    notSent(x);
    expect(x.reason).toMatch(/\[gmail_auth\].*reauth_required/);
    const y = await run((f) => { f.gmail.drafts.set("draft_0_anni", { status: "not_found" }); });
    notSent(y);
    expect(y.reason).toMatch(/no longer exists in Gmail/);
  });
  it("14 the daily limits (per member, global, and 0 pauses sending)", async () => {
    const perMember = await run(() => undefined, { perMemberDaily: 0 });
    notSent(perMember);
    expect(perMember.reason).toMatch(/\[daily_limit\].*daily sending limit/);
    const global = await run(() => undefined, { globalDaily: 0 });
    notSent(global);
    expect(global.reason).toMatch(/global daily sending limit/);
  });
  it("the daily limit counts sends already made today (IST), and a new day starts fresh", async () => {
    const f = buildSendFixture(Array.from({ length: 4 }, (_, i) => ({ email: `p${i}@c${i}.example.com`, name: `Pat Person${i}`, company: `Co${i}` })), { perMemberDaily: 2, globalDaily: 25, perRun: 10 });
    await f.seed();
    expect((await runSendStep(f.deps())).sent).toBe(2);
    expect((await runSendStep(f.deps())).sent).toBe(0);
    expect(f.gmail.sendCalls()).toHaveLength(2);
    f.clock.now = new Date("2026-11-07T06:00:00.000Z");
    expect((await runSendStep(f.deps())).sent).toBe(2);
  });
});

describe("D: Gmail authentication, quota and API failures", () => {
  const setup = async (script: Parameters<typeof buildSendFixture>[0] = ONE) => {
    const f = buildSendFixture(script);
    await f.seed();
    return f;
  };

  it("a quota/rate-limit error sends nothing, counts nothing, records a retry time and stops the run", async () => {
    const f = await setup();
    f.gmail.sendScript = [{ status: "rate_limited", retryAfterMs: 30 * 60_000 }];
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ sent: 0, failed: 1, stoppedBecause: "rate-limited" });
    const [l] = f.ledger();
    expect(l[3]).toBe("failed_transient");
    expect(new Date(l[17]).getTime()).toBe(NOW.getTime() + 30 * 60_000);
    expect(f.track()[0][21]).toBe("failed");
    expect(f.calls.markMessaged).toEqual([]);
    const { records } = await f.sheet.readSendLedger();
    expect(computeCounters((await f.sheet.readTracking()).records, "2026-11-06", 0, { ledger: records })).toMatchObject({ sentToday: 0, emailsSent: 0, failedSends: 1 });
  });

  it("the retry waits for the back-off, then sends exactly once with no duplicate row for the success", async () => {
    const f = await setup();
    f.gmail.sendScript = [{ status: "rate_limited" }];
    await runSendStep(f.deps());
    expect((await runSendStep(f.deps())).sent).toBe(0); // still backing off
    expect(f.gmail.sendCalls()).toHaveLength(1);
    expect(f.track()[0][25]).toMatch(/retry scheduled after/);
    f.clock.now = new Date(NOW.getTime() + 20 * 60_000);
    expect((await runSendStep(f.deps())).sent).toBe(1);
    expect(f.ledger().map((r) => r[3])).toEqual(["failed_transient", "sent"]);
    expect(f.ledger()[1][16]).toBe("2"); // attempt number carried over
    f.clock.now = new Date(NOW.getTime() + 60 * 60_000);
    expect((await runSendStep(f.deps())).sent).toBe(0);
  });

  it("an authorisation failure records the error, does not count, and retries later", async () => {
    const f = await setup();
    f.gmail.sendScript = [{ status: "auth_failed", reason: "Gmail refused the request (401)" }];
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(f.track()[0][25]).toMatch(/\[gmail_auth\] Gmail refused the request/);
    expect(f.track()[0][23]).toBe("auth");
    expect(f.ledger()[0][3]).toBe("failed_transient");
  });

  it("an invalid-recipient rejection is permanent: flagged for review and never retried", async () => {
    const f = await setup();
    f.gmail.sendScript = [{ status: "rejected", reason: "Invalid To header" }];
    await runSendStep(f.deps());
    expect(f.ledger()[0][3]).toBe("failed_permanent");
    expect(f.track()[0][21]).toBe("review");
    f.clock.now = new Date(NOW.getTime() + 24 * 3600_000);
    await runSendStep(f.deps());
    expect(f.gmail.sendCalls()).toHaveLength(1);
  });

  it("transient failures are not retried forever: after 3 attempts the contact needs manual review", async () => {
    const f = await setup();
    for (let i = 0; i < 3; i++) {
      f.gmail.sendScript = [{ status: "auth_failed", reason: "x" }];
      f.clock.now = new Date(NOW.getTime() + i * 3 * 3600_000);
      await runSendStep(f.deps());
    }
    f.clock.now = new Date(NOW.getTime() + 20 * 3600_000);
    f.gmail.sendScript = [];
    await runSendStep(f.deps());
    expect(f.gmail.sendCalls()).toHaveLength(3);
    expect(f.track()[0][21]).toBe("review");
    expect(f.track()[0][25]).toMatch(/3 send attempts failed/);
  });

  it("an unexpected exception inside a send can never turn into a second send", async () => {
    const f = await setup();
    f.gmail.sendScript = ["throw"];
    const r = await runSendStep(f.deps());
    expect(r.stoppedBecause).toBe("error");
    expect(f.gmail.sendCalls()).toHaveLength(1);
    expect(f.ledger()[0][3]).toBe("sending"); // recorded BEFORE the call; reconciled, not retried
    const r2 = await runSendStep(f.deps()); // too soon to reconcile: nothing happens
    expect(r2.sent).toBe(0);
    expect(f.gmail.sendCalls()).toHaveLength(1);
  });
});

describe("E: uncertain results are reconciled, never blindly retried", () => {
  const uncertain = { status: "uncertain" as const, reason: "no response from Gmail (timeout or network error)" };
  const setup = async () => {
    const f = buildSendFixture(ONE);
    await f.seed();
    return f;
  };

  it("timeout after submit + Gmail proves it was sent -> recorded as sent once (message id from Gmail)", async () => {
    const f = await setup();
    f.gmail.sendScript = [uncertain];
    f.gmail.reconcileScript = [{ state: "sent", messageId: "msg-real" }];
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ sent: 1, reconciled: 1 });
    expect(f.gmail.sendCalls()).toHaveLength(1);
    expect(f.ledger()[0][3]).toBe("sent");
    expect(f.ledger()[0][14]).toBe("msg-real");
    expect(f.ledger()[0][21]).toMatch(/uncertain send result; reconciling.*sent \(confirmed by reconciliation\)/);
  });

  it("timeout + the draft is still there -> not sent; safe retry only after the back-off", async () => {
    const f = await setup();
    f.gmail.sendScript = [uncertain];
    f.gmail.reconcileScript = [{ state: "not_sent" }];
    await runSendStep(f.deps());
    expect(f.ledger()[0][3]).toBe("failed_transient");
    expect((await runSendStep(f.deps())).sent).toBe(0);
    f.clock.now = new Date(NOW.getTime() + 15 * 60_000);
    expect((await runSendStep(f.deps())).sent).toBe(1);
    expect(f.gmail.sendCalls()).toHaveLength(2);
  });

  it("cannot be established -> flagged for manual review, and NEVER resent", async () => {
    const f = await setup();
    f.gmail.sendScript = [uncertain];
    f.gmail.reconcileScript = [{ state: "unknown", reason: "draft is gone and the thread cannot be checked (metadata permission missing)" }];
    const r = await runSendStep(f.deps());
    expect(r).toMatchObject({ sent: 0, needsReview: 1 });
    expect(f.ledger()[0][3]).toBe("uncertain");
    expect(f.track()[0][21]).toBe("uncertain");
    expect(f.track()[0][25]).toMatch(/could not be confirmed/);
    for (let i = 1; i <= 3; i++) {
      f.clock.now = new Date(NOW.getTime() + i * 24 * 3600_000);
      f.gmail.reconcileScript = [{ state: "unknown", reason: "still unknown" }];
      await runSendStep(f.deps());
    }
    expect(f.gmail.sendCalls()).toHaveLength(1);
    expect(f.track()[0][21]).toBe("uncertain");
    expect(computeCounters((await f.sheet.readTracking()).records, "2026-11-06", 0, { ledger: (await f.sheet.readSendLedger()).records })).toMatchObject({ sentToday: 0, sendsNeedingReview: 1 });
  });

  it("an interrupted send (ledger says 'sending', process died) is reconciled on the next run, not resent", async () => {
    const f = await setup();
    f.gmail.sendScript = ["throw"];
    await runSendStep(f.deps());
    expect(f.ledger()[0][3]).toBe("sending");
    f.clock.now = new Date(NOW.getTime() + 5 * 60_000);
    f.gmail.reconcileScript = [{ state: "sent", messageId: "msg-found" }];
    const r = await runSendStep(f.deps());
    expect(r.reconciled).toBe(1);
    expect(f.ledger()[0][3]).toBe("sent");
    expect(f.ledger()[0][14]).toBe("msg-found");
    expect(f.gmail.sendCalls()).toHaveLength(1);
    expect(f.track()[0][21]).toBe("sent");
  });

  it("a stale claim that never reached 'sending' is released and a fresh claim sends once", async () => {
    const f = await setup();
    await f.sheet.ensureTabs();
    await f.sheet.appendSendRecord({
      row: 0, sendKey: "jane@acme.example.com", contactId: f.tracking[0].contactId, claimId: "old-claim", status: "claimed", member: "anni", gmailAccount: "", connectionId: "conn_0", company: "Acme", role: "Software Engineer",
      resumeFile: "", resumeSha256: "", resumeBytes: 0, draftId: "", threadId: "", gmailMessageId: "", wordCount: 0, attempts: 1, notBefore: "", sentAt: "", sentDay: "2026-11-06", reason: "", history: "", createdAt: new Date(NOW.getTime() - 3600_000).toISOString(), updatedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
    }, 2);
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(1);
    expect(f.ledger().map((x) => x[3])).toEqual(["released", "sent"]);
  });

  it("a FRESH claim by another worker blocks this one (no second send)", async () => {
    const f = await setup();
    await f.sheet.ensureTabs();
    await f.sheet.appendSendRecord({
      row: 0, sendKey: "jane@acme.example.com", contactId: f.tracking[0].contactId, claimId: "other-worker", status: "claimed", member: "anni", gmailAccount: "", connectionId: "conn_0", company: "", role: "", resumeFile: "", resumeSha256: "", resumeBytes: 0,
      draftId: "", threadId: "", gmailMessageId: "", wordCount: 0, attempts: 1, notBefore: "", sentAt: "", sentDay: "2026-11-06", reason: "", history: "", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    }, 2);
    await f.seed();
    const r = await runSendStep(f.deps());
    expect(r.sent).toBe(0);
    expect(f.gmail.sendCalls()).toEqual([]);
    expect(f.track()[0][25]).toMatch(/another send to this recipient is claimed/);
  });
});

describe("one outreach per recipient, across members and records", () => {
  it("the same recipient on two Connections owned by two members is sent exactly once", async () => {
    const f = buildSendFixture([
      { email: "same@acme.example.com", name: "Sam Same", company: "Acme", owner: "anni" },
      { email: "same@acme.example.com", name: "Sam Same", company: "Acme", owner: "rishii" },
    ]);
    f.tracking[1].contactId = "HRC-SECONDRECORD";
    await f.seed();
    await runSendStep(f.deps());
    expect(f.gmail.sendCalls()).toHaveLength(1);
    expect(f.ledger().filter((r) => r[3] === "sent")).toHaveLength(1);
  });

  it("imported and manual records of one person: the first sent wins, the other is blocked", async () => {
    const f = buildSendFixture([{ email: "m@acme.example.com", name: "Max Man", company: "Acme" }, { email: "M@Acme.Example.com", name: "Max Man", company: "Acme", owner: "lukky" }]);
    f.tracking[1].source = "manual";
    f.tracking[1].contactId = "HRC-MANUALRECORD";
    await f.seed();
    await runSendStep(f.deps());
    await runSendStep(f.deps());
    expect(f.gmail.sendCalls()).toHaveLength(1);
  });
});

describe("hand-sent drafts and recipients are respected", () => {
  it("a message the member sent by hand from their own draft is not duplicated by automation", async () => {
    const f = buildSendFixture(ONE);
    f.draftLedger.set("contact:conn_0:anni", { status: "sent", detail: "", gmailDraftId: "draft_0_anni" });
    await f.seed();
    await runSendStep(f.deps());
    expect(f.gmail.sendCalls()).toEqual([]);
  });

  it("draft text built by the test fixture is itself valid (sanity)", () => {
    expect(draftBody({ member: "anni", first: "Jane", company: "Acme", role: "Software Engineer" })).toContain("Dear Jane,");
    expect(resumeFile("rishii" as MemberId)).toBe("Rishi_Raj_SDE.pdf");
  });
});
