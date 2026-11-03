import { describe, expect, it } from "vitest";
import { computeCounters } from "@/lib/outreach/sync";
import { emptyDrafts, emptySendFields, type SendRecord, type TrackingRecord } from "@/lib/outreach/types";

const track = (over: Partial<TrackingRecord> = {}): TrackingRecord => ({
  row: 2, contactId: "HRC-1", email: "a@b.example.com", source: "outreach-database", importStatus: "added", connectionId: "c1", ownerMemberId: "anni", importDay: "2026-11-06", claimedAt: "", addedAt: "",
  attempts: 1, segment: "person-and-company", targetRole: "Software Engineer", roleBasis: "", processing: "drafted", drafts: emptyDrafts(), reviewReason: "", ...emptySendFields(), sentAt: "", lastError: "", updatedAt: "", ...over,
});
const led = (over: Partial<SendRecord> = {}): SendRecord => ({
  row: 2, sendKey: "a@b.example.com", contactId: "HRC-1", claimId: "k", status: "sent", member: "anni", gmailAccount: "", connectionId: "c1", company: "", role: "", resumeFile: "", resumeSha256: "", resumeBytes: 0, draftId: "d", threadId: "",
  gmailMessageId: "m1", wordCount: 100, attempts: 1, notBefore: "", sentAt: "", sentDay: "2026-11-06", reason: "", history: "", createdAt: "", updatedAt: "", ...over,
});

describe("EmailsSent / SentToday follow the automated-send rule", () => {
  it("counts a confirmed automated send once (status sent + Gmail message id), per day and per member", () => {
    const c = computeCounters([track()], "2026-11-06", 0, { ledger: [led(), led({ claimId: "k2" })] }); // a duplicate ledger row for the same recipient
    expect(c).toMatchObject({ emailsSent: 1, sentToday: 1, sentTodayByMember: { anni: 1, lukky: 0, rishii: 0 } });
    expect(computeCounters([track()], "2026-11-07", 0, { ledger: [led()] })).toMatchObject({ emailsSent: 1, sentToday: 0 });
  });

  it("does NOT count drafts the members sent by hand (draft ledger 'sent'), with or without a ledger row for another contact", () => {
    const handSent = track({ drafts: { anni: { status: "sent", resume: "x.pdf" }, lukky: { status: "sent", resume: "" }, rishii: { status: "created", resume: "" } } });
    expect(computeCounters([handSent], "2026-11-06", 0, { ledger: [] })).toMatchObject({ emailsSent: 0, sentToday: 0, emailsDrafted: 3 });
    expect(computeCounters([handSent, track({ contactId: "HRC-2", email: "z@y.example.com", connectionId: "c2" })], "2026-11-06", 0, { ledger: [led({ sendKey: "z@y.example.com", contactId: "HRC-2", connectionId: "c2" })] }).emailsSent).toBe(1);
  });

  it("does not count unconfirmed or message-id-less rows, nor any other status", () => {
    const rows = [led({ gmailMessageId: "" }), led({ sendKey: "b@b.example.com", status: "uncertain" }), led({ sendKey: "c@b.example.com", status: "sending" }), led({ sendKey: "d@b.example.com", status: "failed_transient" }), led({ sendKey: "e@b.example.com", status: "superseded" }), led({ sendKey: "f@b.example.com", status: "claimed" })];
    expect(computeCounters([track()], "2026-11-06", 0, { ledger: rows })).toMatchObject({ emailsSent: 0, sentToday: 0 });
  });
});
