/**
 * Keeps the tracking tab truthful: derives each contact's processing status from the draft ledger (NF_Drafts, the existing source
 * of truth for drafts) and computes the counters. Counters are DERIVED from tracking records, never incremented by hand, so a
 * failed or incomplete operation can never inflate them.
 */
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { dateInTimezone, nowIso } from "@/lib/utils/time";
import type { Connection } from "@/types/domain";
import { serializeTracking, type OutreachSheet } from "./sheet";
import type { DailyCounters, MemberDraftInfo, ProcessingStatus, SendRecord, TrackingRecord } from "./types";

export interface LedgerEntry {
  status: string;
  detail: string;
  /** Gmail draft id / thread of the draft (used by the send workflow). */
  gmailDraftId?: string;
  threadId?: string;
}

export const draftKeyFor = (connectionId: string, member: MemberId) => `contact:${connectionId}:${member}`;

/** "attached: file.pdf" in a ledger detail -> the file; a created draft without it -> "none". */
export function resumeFromDetail(status: string, detail: string): string {
  if (status !== "created" && status !== "sent") return "";
  return /(?:^|; )attached: ([^;]+)/.exec(detail)?.[1]?.trim() ?? "none";
}

const reviewsIn = (detail: string): string[] => detail.split("; ").filter((p) => p.startsWith("review:")).map((p) => p.slice(7).trim());

export interface Derived {
  drafts: TrackingRecord["drafts"];
  processing: ProcessingStatus;
  reviewReason: string;
  allSent: boolean;
}

/** Pure: the processing state of one connection from its ledger entries. `connected` = members whose Gmail is connected. */
export function deriveProcessing(connectionId: string, ledger: ReadonlyMap<string, LedgerEntry>, connected: readonly MemberId[]): Derived {
  const drafts = {} as Record<MemberId, MemberDraftInfo>;
  const reviews: string[] = [];
  for (const m of MEMBER_IDS) {
    const e = ledger.get(draftKeyFor(connectionId, m));
    drafts[m] = { status: e?.status ?? "", resume: e ? resumeFromDetail(e.status, e.detail) : "" };
    if (e && (e.status === "created" || e.status === "sent")) reviews.push(...reviewsIn(e.detail));
  }
  const made = MEMBER_IDS.filter((m) => drafts[m].status === "created" || drafts[m].status === "sent");
  const failed = MEMBER_IDS.filter((m) => drafts[m].status === "failed");
  const relevant = connected.length ? connected : MEMBER_IDS;
  // "All sent" means every member who is expected to send has sent. It must NOT mean "every draft that exists so far has been sent": a member whose
  // draft is skipped (Gmail was not connected), failed or not written yet still has an e-mail to send, and a contact marked "sent" is never looked at again.
  const allSent = made.length > 0 && relevant.every((m) => drafts[m].status === "sent");
  let processing: ProcessingStatus;
  if (made.length === 0) processing = failed.length ? "failed" : "awaiting";
  else if (reviews.length) processing = "needs_review";
  else if (relevant.every((m) => made.includes(m))) processing = allSent ? "sent" : "drafted";
  else processing = "drafting";
  return { drafts, processing, reviewReason: [...new Set(reviews)].join(" | ").slice(0, 600), allSent };
}

export interface SyncDeps {
  sheet: Pick<OutreachSheet, "readTracking" | "updateTracking">;
  ledger: ReadonlyMap<string, LedgerEntry>;
  connected: readonly MemberId[];
  connections: readonly Connection[];
  now: () => Date;
}

/** Writes changed processing states back to the tracking tab. Returns the up-to-date records. */
export async function syncTracking(deps: SyncDeps): Promise<{ records: TrackingRecord[]; updated: number }> {
  const { records } = await deps.sheet.readTracking();
  const live = new Set(deps.connections.map((c) => c.connectionId));
  const stamp = nowIso(deps.now());
  let updated = 0;
  for (const r of records) {
    if (r.importStatus !== "added" || !r.connectionId) continue;
    const before = serializeTracking(r).join("\u0001");
    if (!live.has(r.connectionId)) {
      // A member deleted the Connection: it is history now, nothing further will be drafted for it.
      r.lastError = "connection was deleted";
    } else {
      const d = deriveProcessing(r.connectionId, deps.ledger, deps.connected);
      r.drafts = d.drafts;
      r.processing = d.processing;
      r.reviewReason = d.reviewReason;
      if (d.allSent && r.sendStatus !== "sent") Object.assign(r, { sendStatus: "sent", sentAt: stamp });
      if (r.lastError === "connection was deleted") r.lastError = "";
    }
    if (serializeTracking(r).join("\u0001") !== before) {
      r.updatedAt = stamp;
      await deps.sheet.updateTracking(r);
      updated += 1;
    }
  }
  return { records, updated };
}

export interface CounterExtras {
  /** The send ledger (confirmed sends are counted from here). */
  ledger?: readonly SendRecord[];
  /** ContactIDs in the Outreach Database master list (to count manual-first duplicates). */
  masterIds?: ReadonlySet<string>;
}

/**
 * Counters are DERIVED from confirmed records (tracking rows and the send ledger), never incremented by an attempt:
 * a failed, uncertain or unconfirmed operation cannot raise a "sent" or "drafted" figure.
 */
const distinctSent = (rows: readonly SendRecord[]) => [...new Map(rows.map((r) => [r.sendKey, r])).values()];

export function computeCounters(records: readonly TrackingRecord[], day: string, queueRemaining: number, extras: CounterExtras = {}): DailyCounters {
  const ledger = extras.ledger ?? [];
  const added = records.filter((r) => r.importStatus === "added");
  const pairs = (statuses: readonly string[]) => added.reduce((n, r) => n + MEMBER_IDS.filter((m) => statuses.includes(r.drafts[m].status)).length, 0);
  // Automated sends only: JobSync called the Gmail send API, Gmail confirmed (message id recorded), the ledger says "sent".
  const sentRows = ledger.filter((r) => r.status === "sent" && r.gmailMessageId.trim() !== "");
  const sentToday = distinctSent(sentRows.filter((r) => r.sentDay === day));
  const byMember = { anni: 0, lukky: 0, rishii: 0 } as Record<MemberId, number>;
  for (const r of sentToday) if (r.member in byMember) byMember[r.member as MemberId] += 1;
  return {
    day,
    importedToday: records.filter((r) => r.source === "outreach-database" && r.importDay === day && r.importStatus === "added" && r.lastError !== "linked-existing").length,
    addedToConnections: added.length,
    emailsDrafted: pairs(["created", "sent"]),
    emailsSent: new Set(sentRows.map((r) => r.sendKey)).size, // each recipient once; drafts members sent by hand are NOT counted
    awaitingProcessing: added.filter((r) => r.processing === "awaiting" || r.processing === "drafting").length,
    requiringReview: added.filter((r) => r.processing === "needs_review").length,
    failedProcessing: added.filter((r) => r.processing === "failed").length,
    importFailed: records.filter((r) => r.importStatus === "import_failed").length,
    queueRemaining,
    sentToday: sentToday.length,
    sentTodayByMember: byMember,
    failedSends: ledger.filter((r) => r.status === "failed_permanent" || r.status === "failed_transient").length,
    skippedContacts: added.filter((r) => r.sendStatus === "blocked").length,
    duplicatesPrevented:
      records.filter((r) => r.lastError === "linked-existing").length +
      (extras.masterIds ? records.filter((r) => r.source === "manual" && extras.masterIds!.has(r.contactId)).length : 0) +
      ledger.filter((r) => r.status === "superseded").length,
    sendsNeedingReview: added.filter((r) => r.sendStatus === "review" || r.sendStatus === "uncertain").length,
  };
}

export const todayOf = (now: Date, tz: string) => dateInTimezone(now, tz);
