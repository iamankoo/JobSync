import type { MemberId } from "@/config/members";
import type { Connection } from "@/types/domain";

/**
 * On each scheduled run: for every Network Finder outreach draft still marked "created", ask that member's
 * own Gmail what became of it (read-only). Each member's draft is tracked separately.
 *
 *   still a draft      → nothing changes (checked again next run)
 *   deleted, not sent  → nothing changes in Connections; the draft is no longer tracked
 *   sent               → the person's Connection moves "Not Connected" → "Messaged"
 *   cannot tell        → nothing changes (checked again next run)
 *
 * Only "Not Connected" is ever changed, and only to "Messaged": a connection already Messaged, Connected or
 * Reply is never touched (never downgraded, never marked Connected). Nothing is sent, deleted or modified in
 * anyone's Gmail.
 */
export type DraftFate = "draft_exists" | "sent" | "deleted" | "unknown";

export interface TrackedDraft {
  draftKey: string;
  memberId: MemberId;
  /** The Connection the draft is about. */
  connectionId: string;
  gmailDraftId: string;
  threadId?: string;
  checkedAt?: string;
}

export interface SentTrackerDeps {
  /** Outreach drafts still awaiting a verdict (status "created"). */
  pendingDrafts(): Promise<TrackedDraft[]>;
  markDraft(draft: TrackedDraft, status: "sent" | "deleted" | "created", checkedAt: string): Promise<void>;
  checkDraft(memberId: MemberId, draftId: string, threadId: string | undefined): Promise<DraftFate>;
  getConnection(connectionId: string): Promise<Connection | undefined>;
  /** Sets status "Messaged" through the existing Connections service. */
  markMessaged(connection: Connection): Promise<void>;
  now?: () => Date;
}

export interface SentTrackingResult {
  checked: number;
  sent: { memberId: MemberId; connectionId: string }[];
  deleted: number;
  stillDrafts: number;
  unknown: number;
  /** Connections moved to Messaged in this run. */
  markedMessaged: string[];
}

export async function runSentTracking(deps: SentTrackerDeps, limit = 30): Promise<SentTrackingResult> {
  const at = (deps.now ? deps.now() : new Date()).toISOString();
  // Oldest-checked first, so every draft gets its turn even when there are more than `limit`.
  const drafts = (await deps.pendingDrafts()).sort((a, b) => (a.checkedAt ?? "").localeCompare(b.checkedAt ?? "")).slice(0, limit);
  const result: SentTrackingResult = { checked: 0, sent: [], deleted: 0, stillDrafts: 0, unknown: 0, markedMessaged: [] };
  const sentConnections = new Set<string>();

  for (const d of drafts) {
    result.checked += 1;
    let fate: DraftFate;
    try {
      fate = await deps.checkDraft(d.memberId, d.gmailDraftId, d.threadId);
    } catch {
      fate = "unknown";
    }
    if (fate === "sent") {
      await deps.markDraft(d, "sent", at);
      result.sent.push({ memberId: d.memberId, connectionId: d.connectionId });
      sentConnections.add(d.connectionId);
    } else if (fate === "deleted") {
      await deps.markDraft(d, "deleted", at);
      result.deleted += 1;
    } else {
      await deps.markDraft(d, "created", at); // just records the check time
      if (fate === "draft_exists") result.stillDrafts += 1;
      else result.unknown += 1;
    }
  }

  for (const connectionId of sentConnections) {
    const c = await deps.getConnection(connectionId);
    if (!c || c.status !== "Not Connected") continue; // deleted, or already further along: leave it
    await deps.markMessaged(c);
    result.markedMessaged.push(connectionId);
  }
  return result;
}
