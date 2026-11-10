import { describe, expect, it } from "vitest";
import { checkAttachment, checkDraft, bodyWordCount } from "@/lib/outreach/draft-check";
import { isExcluded } from "@/lib/outreach/exclusions";
import { claimSend, releaseStaleClaims, withHistory } from "@/lib/outreach/send-ledger";
import { loadOutreachConfig } from "@/lib/outreach/config";
import type { DraftReadback } from "@/lib/gmail/send";
import { newOutreachSpreadsheet, masterGrid } from "../../helpers/outreach";
import { draftBody } from "../../helpers/send-fixture";

describe("limits: only the IMPORT limit remains; sending has no JobSync cap", () => {
  it("the import limit is 200 shared Connections per rolling 24 h and can only be lowered", () => {
    const c = loadOutreachConfig({ OUTREACH_DAILY_LIMIT: "200" } as unknown as NodeJS.ProcessEnv);
    expect(c.dailyLimit).toBe(200);
    expect(loadOutreachConfig({ OUTREACH_DAILY_LIMIT: "9999" } as unknown as NodeJS.ProcessEnv).dailyLimit).toBe(200);
    expect(loadOutreachConfig({ OUTREACH_DAILY_LIMIT: "50" } as unknown as NodeJS.ProcessEnv).dailyLimit).toBe(50);
  });
  it("the old send-limit settings are gone: setting them changes nothing and the config has no sending limits", () => {
    const c = loadOutreachConfig({ OUTREACH_SEND_PER_MEMBER_DAILY: "1", OUTREACH_SEND_GLOBAL_DAILY: "1", OUTREACH_SEND_PER_RUN: "1" } as unknown as NodeJS.ProcessEnv);
    expect(Object.keys(c)).not.toContain("sendLimits");
    expect(JSON.stringify(c)).not.toMatch(/perMemberDaily|globalDaily/);
  });
  it("limits.ts exports no sending cap", async () => {
    const mod = await import("@/lib/outreach/limits");
    expect(Object.keys(mod)).toEqual(["CLAIM_TTL_MS"]);
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
