import "server-only";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { checkDraftState, createDraftFor, isGmailConnected } from "@/lib/gmail/drafts";
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
    createDraft: (memberId, msg) => createDraftFor(memberId, msg),
    isConnected: (memberId) => isGmailConnected(memberId),
    ledger: {
      get: async (key) => (await readDraftLedger({ fresh: true })).get(key),
      record: (e) => recordDraft({ ...e, createdAt: nowIso() }),
    },
    snapshot: async () => readDraftLedger({ fresh: true }),
  };
}

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
