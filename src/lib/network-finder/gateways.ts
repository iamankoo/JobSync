import "server-only";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { checkDraftState, createDraftFor, isGmailConnected } from "@/lib/gmail/drafts";
import { getDraftBacklogGate } from "@/lib/gmail/draft-backlog";
import { MAX_ATTACHMENT_BYTES, type ResumeLookup } from "@/lib/gmail/attachment";
import { planResume } from "@/config/resume-map";
import { onSheetsClientReset } from "@/lib/google-sheets/client";
import { listResumes, loadResume } from "@/lib/google-sheets/member-files-service";
import { notifyMember } from "@/lib/push/notify";
import { nowIso } from "@/lib/utils/time";
import type { BatchNotifier, DraftStepDeps } from "./pipeline";
import { readDraftLedger, recordDraft } from "@/lib/gmail/store";
import { createConnection, updateConnection } from "@/lib/google-sheets/connections-service";
import { DomainError } from "@/lib/google-sheets/errors";
import { createJob } from "@/lib/google-sheets/jobs-service";
import { readConnectionsLocated, readJobs } from "@/lib/google-sheets/repositories";
import { createConnectionSchema } from "@/lib/validation/connections";
import { createJobSchema } from "@/lib/validation/jobs";
import type { Connection, Job } from "@/types/domain";
import type { ConnectionInput, JobInput } from "./mapping";
import type { SentTrackerDeps } from "./sent-tracker";

/**
 * The ONLY way the Network Finder writes data: through the existing Connections and Jobs services, with the
 * same validation as the app's own forms. No second contact or job store exists.
 */
export interface ConnectionsGateway {
  /** Current Connections, read fresh (not from the short read cache) for de-duplication. */
  list(): Promise<Connection[]>;
  create(owner: MemberId, input: ConnectionInput): Promise<Connection>;
}

export type JobCreateResult = { created: Job } | { duplicateOf: string };

export interface JobsGateway {
  list(): Promise<Job[]>;
  /** Creates the job, or reports the existing one when the Jobs service finds the same URL. */
  create(owner: MemberId, input: JobInput): Promise<JobCreateResult>;
}

// Automated adds are quiet (`notify: false`): the team gets ONE summary per batch, not a push per contact/job.
export const existingConnections: ConnectionsGateway = {
  list: async () => (await readConnectionsLocated({ fresh: true })).items.map((i) => i.value),
  create: (owner, input) => createConnection(owner, createConnectionSchema.parse(input), new Date(), { notify: false }),
};

export const existingJobs: JobsGateway = {
  list: async () => (await readJobs({ fresh: true })).items,
  create: async (owner, input) => {
    try {
      return { created: await createJob(owner, createJobSchema.parse(input), new Date(), { notify: false }) };
    } catch (err) {
      // The Jobs service's own duplicate-URL check (under its write lock) is the final word.
      if (err instanceof DomainError && err.code === "duplicate_url") return { duplicateOf: String(err.details?.existingJobId ?? "") };
      throw err;
    }
  },
};

/** Real wiring for the per-member Gmail draft step: each member's own Gmail + the NF_Drafts ledger. */
export function existingDraftDeps(): DraftStepDeps {
  return {
    // Backlog protection for EVERY production draft-creation path (Outreach cycle and Network Finder cron): see gmail/draft-backlog.ts.
    backlog: getDraftBacklogGate(),
    createDraft: (memberId, msg) => createDraftFor(memberId, msg),
    isConnected: (memberId) => isGmailConnected(memberId),
    ledger: {
      get: async (key) => (await readDraftLedger({ fresh: true })).get(key),
      record: (e) => recordDraft({ ...e, createdAt: nowIso() }),
    },
    snapshot: async () => readDraftLedger({ fresh: true }),
  };
}

/**
 * The member's resume for a role, from THEIR OWN uploaded PDFs only (a file of another member can never be returned: every read
 * is scoped to the member id). config/resume-map.ts decides the file (specialised resume, else the same member's SDE resume);
 * the file is matched by exact name, and zero or several matches, a non-PDF or an unreadable file is never attached. The bytes
 * are read, never changed.
 */
/**
 * The bytes of a resume are stored in the ChatFiles tab and are expensive to read (every send check used to download the whole PDF again: 24 reads
 * for 12 checks). A loaded, validated resume is remembered for a few minutes, keyed by member, record id, name, size and upload time, so a replaced,
 * renamed or re-uploaded file is never served stale. The member's file LIST is still read for every lookup (it is cached for seconds by the table layer).
 */
const RESUME_CACHE_TTL_MS = 10 * 60_000;
const RESUME_CACHE_MAX = 24;
const resumeCache = new Map<string, { at: number; fileName: string; bytes: Uint8Array }>();
onSheetsClientReset(() => resumeCache.clear());

export const existingResumes: ResumeLookup = async (member, roleTitle) => {
  const memberId = member as MemberId;
  let uploads;
  try {
    uploads = (await listResumes(memberId)) ?? [];
  } catch {
    return { status: "unreadable", reason: "the member's uploads could not be listed" };
  }
  const plan = planResume(memberId, roleTitle, uploads);
  if (plan.status === "none") return { status: "unmapped", reason: plan.reason };
  const mine = uploads.filter((r) => r.fileName.toLowerCase() === plan.fileName.toLowerCase());
  if (mine.length !== 1) return { status: "unreadable", reason: `${plan.fileName} is not a single unambiguous upload` };
  try {
    const rec = mine[0];
    const cacheKey = `${memberId}|${rec.recordId}|${rec.fileName}|${rec.sizeBytes}|${rec.uploadedAt}`;
    const hit = resumeCache.get(cacheKey);
    if (hit && Date.now() - hit.at < RESUME_CACHE_TTL_MS) {
      return { status: "attached", kind: plan.kind, ...(plan.reason ? { note: plan.reason } : {}), attachment: { fileName: hit.fileName, mimeType: "application/pdf", bytes: hit.bytes } };
    }
    const { info, bytes } = await loadResume(memberId, rec.recordId);
    const head = Buffer.from(bytes).subarray(0, 5).toString("latin1");
    if (head !== "%PDF-" || bytes.length > MAX_ATTACHMENT_BYTES) return { status: "unreadable", reason: "the file is not a valid PDF" };
    const valid = new Uint8Array(bytes);
    // Only a validated file is remembered; the oldest entry goes when the memory is full.
    if (resumeCache.size >= RESUME_CACHE_MAX) resumeCache.delete(resumeCache.keys().next().value as string);
    resumeCache.set(cacheKey, { at: Date.now(), fileName: info.fileName, bytes: valid });
    return { status: "attached", kind: plan.kind, ...(plan.reason ? { note: plan.reason } : {}), attachment: { fileName: info.fileName, mimeType: "application/pdf", bytes: valid } };
  } catch {
    return { status: "unreadable", reason: "the file could not be loaded" };
  }
};

/** ONE push to every member's devices (batch summaries, the contact-limit warning). Never throws. */
export const teamNotifier: BatchNotifier = {
  async notifyTeam({ title, body, tag }) {
    for (const m of MEMBER_IDS) {
      try {
        await notifyMember(m, { title, body, url: "/connections", tag });
      } catch {
        console.warn("[network-finder] summary notification could not be delivered to one member");
      }
    }
  },
};

/**
 * Real wiring for the sent-draft tracker: the draft ledger (NF_Drafts), each member's own Gmail (read-only
 * checks), and the existing Connections service for the status change.
 */
export function existingSentTrackerDeps(): SentTrackerDeps {
  return {
    pendingDrafts: async () =>
      [...(await readDraftLedger({ fresh: true })).values()]
        .filter((d) => d.status === "created" && d.itemType === "contact" && d.gmailDraftId)
        .map((d) => ({ draftKey: d.draftKey, memberId: d.memberId, connectionId: d.itemId, gmailDraftId: d.gmailDraftId, ...(d.threadId ? { threadId: d.threadId } : {}), ...(d.checkedAt ? { checkedAt: d.checkedAt } : {}) })),
    markDraft: async (d, status, checkedAt) => {
      const current = (await readDraftLedger({ fresh: true })).get(d.draftKey);
      if (current) await recordDraft({ ...current, status, checkedAt });
    },
    checkDraft: (memberId, draftId, threadId) => checkDraftState(memberId, draftId, threadId),
    getConnection: async (id) => (await readConnectionsLocated({ fresh: true })).items.find((i) => i.value.connectionId === id)?.value,
    // Acting for the entry's owner (Network Finder entries are owned by Anni); only the status changes.
    markMessaged: async (c) => {
      await updateConnection(c.memberId, c.connectionId, { status: "Messaged" });
    },
  };
}
