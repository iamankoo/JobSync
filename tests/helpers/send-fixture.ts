/**
 * Fixtures for the send workflow: an in-memory Outreach Database (real OutreachSheet over FakeSheets), scriptable Gmail / resume /
 * Connections / draft-ledger ports, and a builder for valid draft text. Nothing here touches Google or sends anything.
 */
import type { MemberId } from "@/config/members";
import { getMember } from "@/config/members";
import type { ResumeLookup, ResumeResult } from "@/lib/gmail/attachment";
import type { DraftInspection, DraftReadback, Reconciliation, ReadResult, SendOutcome } from "@/lib/gmail/send";
import { contactIdFor } from "@/lib/hr-master/ids";

import type { DraftInfo, GmailPort, SendDeps } from "@/lib/outreach/send-workflow";
import { withParkedReason } from "@/lib/gmail/draft-flags";
import { draftKeyFor } from "@/lib/outreach/sync";
import { emptyDrafts, emptySendFields, type TrackingRecord } from "@/lib/outreach/types";
import type { Connection } from "@/types/domain";
import { masterGrid, masterRow, newOutreachSpreadsheet } from "./outreach";

export const NOW = new Date("2026-11-06T06:00:00.000Z"); // 11:30 IST on 6 Nov 2026

export function draftBody(o: { member: MemberId; first?: string; company?: string; role: string }): string {
  const m = getMember(o.member)!;
  return [
    `Dear ${o.first ?? "Hiring Team"},`,
    "I hope you're doing well.",
    `I'm ${m.fullName}, a final-year student, and I'm interested in the ${o.role} opportunity at ${o.company ?? "your company"}. I have built several projects that apply the skills this role needs, and I enjoy turning ideas into dependable software that people can use.`,
    "I'd appreciate the chance to discuss how my background could contribute to your engineering team, and would be grateful for your consideration or a referral.",
    "I have attached my resume for your reference. Thank you for your time and consideration.",
    `Best regards,\n${m.fullName}\nLinkedIn: ${m.linkedinUrl}\nGitHub: ${m.githubUrl}`,
  ].join("\n\n");
}

export const resumeFile = (m: MemberId) => ({ anni: "Aniket_Raj_SDE.pdf", lukky: "Lakshya_SDE.pdf", rishii: "Rishi_Raj_SDE.pdf" })[m];
export const resumeBytes = (m: MemberId) => new TextEncoder().encode(`%PDF-1.4 resume of ${m} ${"x".repeat(40)}`);

export class FakeGmail implements GmailPort {
  calls: string[] = [];
  addresses: Partial<Record<MemberId, string | null>> = { anni: "aniket@gmail.test", lukky: "lakshya@gmail.test", rishii: "rishi@gmail.test" };
  drafts = new Map<string, ReadResult>();
  /** Scripted send outcomes, consumed in order; default = a confirmed send. */
  sendScript: (SendOutcome | { status: "no_access"; access: string } | "throw")[] = [];
  reconcileScript: Reconciliation[] = [];
  /** Scripted answers to inspect() for a draft Gmail has just REFUSED as "Message not a draft" (see refuseAsNotADraftFor); otherwise inspect() reports the labels of the stored draft. */
  inspectScript: (DraftInspection | "throw")[] = [];
  /** Members whose drafts.send is answered with Gmail's "Message not a draft" (the draft was sent by hand between the readback and the send). */
  refuseAsNotADraftFor = new Set<MemberId>();
  refusedDrafts = new Set<string>();
  /** While true, the pre-send inspection cannot reach Gmail (answers unknown). */
  inspectDown = false;
  /** Called right after a draft was read back (lets a test change the world between the readback and the send). */
  onRead?: (member: MemberId, draftId: string) => void;
  /** Called at the start of every inspect() (lets a test advance the clock between the claim and the send). */
  onInspect?: (member: MemberId, draftId: string) => void;
  /** The attempt start times reconcile() was given, in order. */
  reconcileSince: (number | undefined)[] = [];
  /** Marks a draft as already SENT outside JobSync: Gmail still resolves the id, but the message is labelled SENT (this is what Gmail really does). */
  markSentOutside(draftId: string) {
    const d = this.drafts.get(draftId);
    if (d?.status === "ok") this.drafts.set(draftId, { status: "ok", draft: { ...d.draft, labelIds: ["SENT"] } });
  }
  /** The member deleted the draft by hand: Gmail answers 404. */
  deleteDraft(draftId: string) {
    this.drafts.delete(draftId);
  }
  sentMessages: { member: MemberId; draftId: string }[] = [];
  async address(m: MemberId) {
    this.calls.push(`address:${m}`);
    return this.addresses[m] ?? null;
  }
  async readDraft(m: MemberId, id: string): Promise<ReadResult> {
    this.calls.push(`read:${m}:${id}`);
    const out = this.drafts.get(id) ?? { status: "not_found" as const };
    this.onRead?.(m, id);
    return out;
  }
  async send(m: MemberId, id: string) {
    this.calls.push(`send:${m}:${id}`);
    if (this.refuseAsNotADraftFor.has(m)) {
      this.refusedDrafts.add(id);
      return { status: "not_a_draft" as const };
    }
    const next = this.sendScript.shift();
    if (next === "throw") throw new Error("boom");
    if (next) return next;
    this.sentMessages.push({ member: m, draftId: id });
    return { status: "sent" as const, messageId: `msg-${this.sentMessages.length}`, threadId: `thr-${id}` };
  }
  async reconcile(m: MemberId, id: string, _thread?: string, sinceMs?: number): Promise<Reconciliation> {
    this.calls.push(`reconcile:${m}:${id}`);
    this.reconcileSince.push(sinceMs);
    return this.reconcileScript.shift() ?? { state: "unknown", reason: "no script" };
  }
  async inspect(m: MemberId, id: string): Promise<DraftInspection> {
    this.calls.push(`inspect:${m}:${id}`);
    this.onInspect?.(m, id);
    if (this.refusedDrafts.has(id)) {
      const next = this.inspectScript.shift();
      if (next === "throw") throw new Error("gmail down");
      return next ?? { state: "unknown", reason: "no script" };
    }
    if (this.inspectDown) return { state: "unknown", reason: "Gmail answered 503" };
    // Like real Gmail: the labels of the message behind the stored draft decide.
    const d = this.drafts.get(id);
    if (!d || d.status !== "ok") return { state: "unknown", reason: "draft not found" };
    const labels = d.draft.labelIds;
    if (!labels) return { state: "unknown", reason: "no labels reported" };
    if (labels.includes("SENT")) return { state: "sent_outside", messageId: `msg-out-${id}` };
    return labels.includes("DRAFT") ? { state: "pending_draft" } : { state: "unknown", reason: "neither DRAFT nor SENT" };
  }
  sendCalls = () => this.calls.filter((c) => c.startsWith("send:"));
}

export interface ContactSpec {
  email: string;
  name?: string;
  company?: string;
  owner?: MemberId;
  role?: string;
  /** Whose mailbox holds a personalised draft for this Connection. Default: only the owner (legacy); pass all three for the shared-Connection fan-out. */
  members?: MemberId[];
}

export function buildSendFixture(specs: ContactSpec[] = [{ email: "jane@acme.example.com", name: "Jane Doe", company: "Acme" }]) {
  const master = specs.map((s) => masterRow({ PersonEmail: s.email, PersonName: s.name ?? "", CompanyName: s.company ?? "" }));
  const out = newOutreachSpreadsheet(masterGrid(master));
  const gmail = new FakeGmail();
  const connections = new Map<string, Connection>();
  const draftLedger = new Map<string, DraftInfo>();
  const tracking: TrackingRecord[] = [];
  const calls = { markMessaged: [] as string[], markSent: [] as string[], parked: [] as string[] };
  let resumeMode: "ok" | "unmapped" | "missing" | "wrong_size" = "ok";

  specs.forEach((s, i) => {
    const owner = s.owner ?? "anni";
    const role = s.role ?? "Software Engineer";
    const connectionId = `conn_${i}`;
    connections.set(connectionId, {
      connectionId, memberId: owner, name: s.name || "Hiring Team", ...(s.company ? { company: s.company } : {}), email: s.email, roleCategory: "SDE", applyRole: role, status: "Not Connected",
      createdAt: "2026-11-05T05:00:00.000Z", updatedAt: "2026-11-05T05:00:00.000Z",
    });
    const first = s.name ? s.name.split(" ")[0] : undefined;
    for (const m of s.members ?? [owner]) {
      const draftId = `draft_${i}_${m}`;
      draftLedger.set(draftKeyFor(connectionId, m), { status: "created", detail: `attached: ${resumeFile(m)}`, gmailDraftId: draftId, threadId: `thr_${i}_${m}` });
      gmail.drafts.set(draftId, {
        status: "ok",
        draft: { to: s.email, from: gmail.addresses[m] ?? "", subject: `Application for ${role} — ${s.company ?? "your company"}`, body: draftBody({ member: m, ...(first ? { first } : {}), ...(s.company ? { company: s.company } : {}), role }), attachments: [{ filename: resumeFile(m), size: resumeBytes(m).length }], labelIds: ["DRAFT"], threadId: `thr_${i}_${m}` } satisfies DraftReadback,
      });
    }
    tracking.push({
      row: 0, contactId: contactIdFor(s.email), email: s.email, source: "outreach-database", importStatus: "added", connectionId, ownerMemberId: owner, importDay: "2026-11-05", claimedAt: "2026-11-05T05:00:00.000Z",
      addedAt: `2026-11-05T05:00:0${i}.000Z`, attempts: 1, segment: "person-and-company", targetRole: role, roleBasis: "default-fallback", processing: "drafted", drafts: emptyDrafts(), reviewReason: "", ...emptySendFields(), sentAt: "", lastError: "", updatedAt: "",
    });
  });

  const resumes: ResumeLookup = async (member): Promise<ResumeResult> => {
    if (resumeMode === "unmapped") return { status: "unmapped", reason: "no SDE resume uploaded" };
    if (resumeMode === "missing") return { status: "missing", fileName: resumeFile(member as MemberId) };
    const bytes = resumeMode === "wrong_size" ? new Uint8Array(7) : resumeBytes(member as MemberId);
    return { status: "attached", attachment: { fileName: resumeFile(member as MemberId), mimeType: "application/pdf", bytes } };
  };

  const clock = { now: NOW };
  const deps = (over: Partial<SendDeps> = {}): SendDeps => ({
    gate: true,
    sheet: out.sheet,
    gmail,
    resumes,
    connections: {
      listFresh: async () => [...connections.values()],
      markMessaged: async (c) => {
        calls.markMessaged.push(c.connectionId);
        connections.set(c.connectionId, { ...c, status: "Messaged" });
      },
    },
    drafts: {
      snapshot: async () => new Map(draftLedger),
      markSent: async (m, connectionId) => {
        calls.markSent.push(`${m}:${connectionId}`);
        const k = draftKeyFor(connectionId, m);
        draftLedger.set(k, { ...draftLedger.get(k)!, status: "sent" });
      },
      // Same effect as the production wiring: only the ledger row's note changes (the Gmail draft is never touched).
      setParked: async (m, connectionId, reason) => {
        const k = draftKeyFor(connectionId, m);
        const cur = draftLedger.get(k);
        calls.parked.push(`${m}:${connectionId}:${reason ?? "cleared"}`);
        if (cur && cur.status === "created") draftLedger.set(k, { ...cur, detail: withParkedReason(cur.detail, reason) });
      },
    },
    now: () => clock.now,
    timezone: "Asia/Kolkata",
    ...over,
  });

  return {
    ...out, gmail, connections, draftLedger, tracking, calls, clock, deps,
    setResume: (m: typeof resumeMode) => { resumeMode = m; },
    /** Writes the tracking rows (as the import/draft steps would have). */
    async seed() {
      await out.sheet.ensureTabs();
      const { nextRow } = await out.sheet.readTracking();
      let row = nextRow;
      for (const t of tracking) await out.sheet.appendTracking(t, row++);
    },
    ledger: () => out.fake.dataRows("Outreach Send Ledger").filter((r) => r[0]),
    track: () => out.fake.dataRows("Added in Outreach Emails").filter((r) => r[0]),
  };
}
