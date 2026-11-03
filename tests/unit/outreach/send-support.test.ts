import { describe, expect, it } from "vitest";
import { checkAttachment, checkDraft, bodyWordCount } from "@/lib/outreach/draft-check";
import { isExcluded } from "@/lib/outreach/exclusions";
import { DEFAULT_SEND_LIMITS, MAX_SEND_LIMITS, limitReason, loadSendLimits, usageToday } from "@/lib/outreach/limits";
import { claimSend, releaseStaleClaims, withHistory } from "@/lib/outreach/send-ledger";
import { loadOutreachConfig } from "@/lib/outreach/config";
import type { SendRecord } from "@/lib/outreach/types";
import type { DraftReadback } from "@/lib/gmail/send";
import { newOutreachSpreadsheet, masterGrid } from "../../helpers/outreach";
import { draftBody } from "../../helpers/send-fixture";

describe("send limits: conservative defaults, hard ceilings, never unlimited", () => {
  it("defaults", () => {
    expect(loadSendLimits({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_SEND_LIMITS);
    expect(DEFAULT_SEND_LIMITS).toEqual({ perMemberDaily: 10, globalDaily: 25, perRun: 3 });
  });
  it("can be lowered (0 pauses sending) or raised only up to the ceilings; anything else falls back to the default", () => {
    const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
    expect(loadSendLimits(env({ OUTREACH_SEND_PER_MEMBER_DAILY: "0" })).perMemberDaily).toBe(0);
    expect(loadSendLimits(env({ OUTREACH_SEND_PER_MEMBER_DAILY: "50", OUTREACH_SEND_GLOBAL_DAILY: "100" }))).toMatchObject({ perMemberDaily: 50, globalDaily: 100 });
    for (const bad of ["51", "1000000", "-1", "1.5", "abc", "Infinity", "NaN"]) expect(loadSendLimits(env({ OUTREACH_SEND_PER_MEMBER_DAILY: bad })).perMemberDaily, bad).toBe(10);
    expect(loadSendLimits(env({ OUTREACH_SEND_PER_RUN: "11" })).perRun).toBe(3);
    expect(MAX_SEND_LIMITS).toEqual({ perMemberDaily: 50, globalDaily: 100, perRun: 10 });
  });
  it("the global limit can never exceed what the three per-member limits allow", () => {
    expect(loadSendLimits({ OUTREACH_SEND_PER_MEMBER_DAILY: "2", OUTREACH_SEND_GLOBAL_DAILY: "90" } as unknown as NodeJS.ProcessEnv).globalDaily).toBe(6);
  });
  it("is independent of the import limit", () => {
    const c = loadOutreachConfig({ OUTREACH_DAILY_LIMIT: "200" } as unknown as NodeJS.ProcessEnv);
    expect(c.dailyLimit).toBe(200);
    expect(c.sendLimits.globalDaily).toBeLessThan(c.dailyLimit);
  });
  const row = (over: Partial<SendRecord>): SendRecord => ({ row: 2, sendKey: "a@b.co", contactId: "x", claimId: "c", status: "sent", member: "anni", gmailAccount: "", connectionId: "", company: "", role: "", resumeFile: "", resumeSha256: "", resumeBytes: 0, draftId: "", threadId: "", gmailMessageId: "", wordCount: 0, attempts: 1, notBefore: "", sentAt: "", sentDay: "2026-11-06", reason: "", history: "", createdAt: "2026-11-06T06:00:00.000Z", updatedAt: "2026-11-06T06:00:00.000Z", ...over });
  it("usage counts confirmed, in-flight and uncertain sends of TODAY (IST) and ignores failed / released / superseded / other days", () => {
    const now = Date.parse("2026-11-06T06:01:00.000Z");
    const u = usageToday([row({}), row({ status: "sending", member: "lukky" }), row({ status: "uncertain" }), row({ status: "failed_transient" }), row({ status: "released" }), row({ status: "superseded" }), row({ sentDay: "2026-11-05" }), row({ status: "claimed" }), row({ status: "claimed", updatedAt: "2026-11-06T04:00:00.000Z" })], "2026-11-06", now);
    expect(u).toEqual({ global: 4, byMember: { anni: 3, lukky: 1, rishii: 0 } });
    expect(limitReason(DEFAULT_SEND_LIMITS, { global: 25, byMember: { anni: 0, lukky: 0, rishii: 0 } }, "anni", 0)).toMatch(/global daily/);
    expect(limitReason(DEFAULT_SEND_LIMITS, { global: 3, byMember: { anni: 10, lukky: 0, rishii: 0 } }, "anni", 0)).toMatch(/anni's daily/);
    expect(limitReason(DEFAULT_SEND_LIMITS, { global: 3, byMember: { anni: 1, lukky: 0, rishii: 0 } }, "anni", 3)).toMatch(/per-run/);
    expect(limitReason(DEFAULT_SEND_LIMITS, { global: 3, byMember: { anni: 1, lukky: 0, rishii: 0 } }, "anni", 2)).toBeNull();
  });
});

describe("exclusions", () => {
  const list = [{ value: "x@acme.com", reason: "asked to stop" }, { value: "@blocked.org", reason: "" }, { value: "Legal.Example", reason: "legal" }];
  it("matches an address, a domain (with or without @) and sub-domains, case-insensitively", () => {
    expect(isExcluded("X@Acme.com", list)).toBe("asked to stop");
    expect(isExcluded("y@acme.com", list)).toBeNull();
    expect(isExcluded("anyone@blocked.org", list)).toBe("blocked.org");
    expect(isExcluded("a@mail.legal.example", list)).toBe("legal");
    expect(isExcluded("a@notlegal.example", list)).toBeNull();
    expect(isExcluded("a@b.co", [])).toBeNull();
  });
});

describe("draft and attachment checks", () => {
  const draft = (over: Partial<DraftReadback> = {}): DraftReadback => ({ to: "Jane <jane@acme.example.com>", from: "", subject: "Application for Software Engineer — Acme", body: draftBody({ member: "anni", first: "Jane", company: "Acme", role: "Software Engineer" }), attachments: [{ filename: "Aniket_Raj_SDE.pdf", size: 10 }], ...over });
  const exp = { member: "anni" as const, recipientEmail: "jane@acme.example.com", personName: "Jane Doe", companyName: "Acme", applyRole: "Software Engineer" };
  it("passes a correct draft and counts the body words without the signature", () => {
    const c = checkDraft(draft(), exp);
    expect(c.ok).toBe(true);
    expect(c.words).toBe(bodyWordCount(draft().body));
    expect(c.words).toBeLessThanOrEqual(150);
  });
  it("Hiring Team / your company wording is required exactly when the data has no person / company", () => {
    const body = draftBody({ member: "lukky", role: "AI Engineer" });
    expect(checkDraft(draft({ to: "x@y.co", body }), { member: "lukky", recipientEmail: "x@y.co", personName: "Hiring Team", companyName: "", applyRole: "AI Engineer" }).ok).toBe(true);
    expect(checkDraft(draft({ to: "x@y.co", body: body.replace("your company", "Acme") }), { member: "lukky", recipientEmail: "x@y.co", personName: "", companyName: "", applyRole: "AI Engineer" }).ok).toBe(false);
  });
  it("rejects a wrong recipient, a too-short body, and a 151-word body", () => {
    expect(checkDraft(draft({ to: "other@acme.example.com" }), exp).failures[0].check).toBe("recipient");
    expect(checkDraft(draft({ body: "Dear Jane,\n\nHi" }), exp).ok).toBe(false);
    const long = draft().body.replace("Best regards", Array(160).fill("word").join(" ") + "\n\nBest regards");
    expect(checkDraft(draft({ body: long }), exp).failures.some((f) => f.check === "word_limit")).toBe(true);
  });
  it("the attachment must be exactly the expected file name and size; with no resume chosen there must be no attachment", () => {
    expect(checkAttachment(draft(), { fileName: "Aniket_Raj_SDE.pdf", bytes: 10 })).toBeNull();
    expect(checkAttachment(draft(), { fileName: "Aniket_Raj_SDE.pdf", bytes: 11 })).toMatch(/10 bytes, the member's resume is 11/);
    expect(checkAttachment(draft(), { fileName: "Other.pdf", bytes: 10 })).toMatch(/expected "Other.pdf"/);
    expect(checkAttachment(draft({ attachments: [] }), { fileName: "x.pdf", bytes: 1 })).toMatch(/found 0/);
    expect(checkAttachment(draft({ attachments: [] }), null)).toBeNull();
    expect(checkAttachment(draft(), null)).toMatch(/no resume could be chosen/);
  });
});

describe("the claim protocol on the send ledger", () => {
  const input = (member = "anni") => ({ sendKey: "jane@acme.example.com", contactId: "HRC-1", member, gmailAccount: "a@b", connectionId: "c1", company: "Acme", role: "Software Engineer", draftId: "d", threadId: "", resumeFile: "r.pdf", resumeSha256: "", resumeBytes: 1, wordCount: 100 });
  const open = async () => {
    const o = newOutreachSpreadsheet(masterGrid([]));
    await o.sheet.ensureTabs();
    return o;
  };
  const now = new Date("2026-11-06T06:00:00.000Z");

  it("exactly one of many simultaneous claimants wins; the rest are superseded and know it", async () => {
    const o = await open();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claimSend(o.sheet, input(["anni", "lukky", "rishii"][i % 3]), "2026-11-06", now)));
    expect(results.filter((r) => r.won)).toHaveLength(1);
    const rows = o.fake.dataRows("Outreach Send Ledger").filter((r) => r[0]);
    expect(rows.filter((r) => r[3] === "claimed")).toHaveLength(1);
    expect(rows.filter((r) => r[3] === "superseded").length + results.filter((r) => !r.won && r.reason === "in_flight").length).toBeGreaterThanOrEqual(7 - rows.filter((r) => r[3] !== "superseded" && r[3] !== "claimed").length);
    expect(new Set(rows.map((r) => r[2])).size).toBe(rows.length); // unique ClaimIDs
  });

  it("refuses when the key is already sent / in flight / awaiting review / permanently failed", async () => {
    for (const [status, reason] of [["sent", "already_sent"], ["sending", "in_flight"], ["uncertain", "in_flight"], ["needs_review", "needs_review"], ["failed_permanent", "failed_permanent"]] as const) {
      const o = await open();
      const first = await claimSend(o.sheet, input(), "2026-11-06", now);
      expect(first.won).toBe(true);
      if (first.won) await o.sheet.updateSendRecord({ ...first.record, status });
      const second = await claimSend(o.sheet, input("lukky"), "2026-11-06", now);
      expect(second, status).toMatchObject({ won: false, reason });
    }
  });

  it("transient failures allow a new claim with the attempt counted, up to the limit", async () => {
    const o = await open();
    for (let i = 1; i <= 3; i++) {
      const c = await claimSend(o.sheet, input(), "2026-11-06", now);
      expect(c.won).toBe(true);
      if (c.won) {
        expect(c.record.attempts).toBe(i);
        await o.sheet.updateSendRecord({ ...c.record, status: "failed_transient" });
      }
    }
    expect(await claimSend(o.sheet, input(), "2026-11-06", now)).toMatchObject({ won: false, reason: "too_many_attempts" });
  });

  it("stale claims are released; fresh ones are not", async () => {
    const o = await open();
    await claimSend(o.sheet, input(), "2026-11-06", now);
    expect(await releaseStaleClaims(o.sheet, new Date(now.getTime() + 60_000))).toBe(0);
    expect(await releaseStaleClaims(o.sheet, new Date(now.getTime() + 11 * 60_000))).toBe(1);
    expect(o.fake.dataRows("Outreach Send Ledger")[0][3]).toBe("released");
  });

  it("history is capped so a cell never overflows", () => {
    let h = "";
    for (let i = 0; i < 200; i++) h = withHistory(h, "2026-11-06T06:00:00.000Z", "event " + i);
    expect(h.length).toBeLessThanOrEqual(901);
    expect(h).toContain("event 199");
  });
});

describe("tab headers migrate additively", () => {
  it("an older shorter header row is extended; rows are untouched; a conflicting header is refused", async () => {
    const o = newOutreachSpreadsheet(masterGrid([]));
    o.fake.tabs.set("Outreach Daily Counters", [["Day", "ImportedToday"], ["2026-11-05", "3"]]);
    await o.sheet.ensureTabs();
    const t = o.fake.tabs.get("Outreach Daily Counters")!;
    expect(t[0].length).toBeGreaterThan(15);
    expect(t[0].slice(0, 2)).toEqual(["Day", "ImportedToday"]);
    expect(t[1].slice(0, 2)).toEqual(["2026-11-05", "3"]);
    o.fake.tabs.set("Outreach State", [["Wrong", "Header", "X"]]);
    await expect(o.sheet.ensureTabs()).rejects.toThrow(/expected header row/);
  });
});
