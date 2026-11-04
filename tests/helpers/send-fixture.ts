/**
 * Fixtures for the send workflow: an in-memory Outreach Database (real OutreachSheet over FakeSheets), scriptable Gmail / resume /
 * Connections / draft-ledger ports, and a builder for valid draft text. Nothing here touches Google or sends anything.
 */
import type { MemberId } from "@/config/members";
import { getMember } from "@/config/members";
import type { ResumeLookup, ResumeResult } from "@/lib/gmail/attachment";
import type { DraftReadback, Reconciliation, ReadResult, SendOutcome } from "@/lib/gmail/send";
import { contactIdFor } from "@/lib/hr-master/ids";
import { DEFAULT_SEND_LIMITS, type SendLimits } from "@/lib/outreach/limits";
import type { DraftInfo, GmailPort, SendDeps } from "@/lib/outreach/send-workflow";
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
  sentMessages: { member: MemberId; draftId: string }[] = [];
  async address(m: MemberId) {
    this.calls.push(`address:${m}`);
    return this.addresses[m] ?? null;
  }
  async readDraft(m: MemberId, id: string): Promise<ReadResult> {
    this.calls.push(`read:${m}:${id}`);
    return this.drafts.get(id) ?? { status: "not_found" };
  }
  async send(m: MemberId, id: string) {
    this.calls.push(`send:${m}:${id}`);
    const next = this.sendScript.shift();
    if (next === "throw") throw new Error("boom");
    if (next) return next;
    this.sentMessages.push({ member: m, draftId: id });
    return { status: "sent" as const, messageId: `msg-${this.sentMessages.length}`, threadId: `thr-${id}` };
  }
  async reconcile(m: MemberId, id: string): Promise<Reconciliation> {
    this.calls.push(`reconcile:${m}:${id}`);
    return this.reconcileScript.shift() ?? { state: "unknown", reason: "no script" };
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

export function buildSendFixture(specs: ContactSpec[] = [{ email: "jane@acme.example.com", name: "Jane Doe", company: "Acme" }], limits: Partial<SendLimits> = {}) {
  const master = specs.map((s) => masterRow({ PersonEmail: s.email, PersonName: s.name ?? "", CompanyName: s.company ?? "" }));
  const out = newOutreachSpreadsheet(masterGrid(master));
  const gmail = new FakeGmail();
  const connections = new Map<string, Connection>();
  const draftLedger = new Map<string, DraftInfo>();
  const tracking: TrackingRecord[] = [];
  const calls = { markMessaged: [] as string[], markSent: [] as string[] };
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
        draft: { to: s.email, from: gmail.addresses[m] ?? "", subject: `Application for ${role} — ${s.company ?? "your company"}`, body: draftBody({ member: m, ...(first ? { first } : {}), ...(s.company ? { company: s.company } : {}), role }), attachments: [{ filename: resumeFile(m), size: resumeBytes(m).length }], threadId: `thr_${i}_${m}` } satisfies DraftReadback,
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
    },
    limits: { ...DEFAULT_SEND_LIMITS, ...limits },
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
