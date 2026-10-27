import { getMember, MEMBER_IDS, type MemberId } from "@/config/members";
import type { DraftContent } from "./providers/brain";

/**
 * One discovered item (a contact or a job) → one DRAFT in EACH member's own Gmail, independent of who owns
 * the JobSync record or which Apollo account found it. Per member:
 *  - already drafted (ledger) → skipped, so retries never duplicate a draft;
 *  - Gmail not authorised → skipped and recorded; the other members still get theirs;
 *  - composing or Gmail fails → recorded as failed for that member only (retried on a later run).
 * Drafts are only ever created, never sent.
 */
export type DraftItemType = "contact" | "job";

export interface FanoutItem {
  type: DraftItemType;
  /** Stable ID of the Connections/Jobs row the draft is about. */
  id: string;
  /** Recipient, when known (a contact's email). Jobs without an email get a draft with no recipient. */
  to?: string;
}

export interface MemberDraftOutcome {
  memberId: MemberId;
  result: "created" | "already_drafted" | "not_authorized" | "reauth_required" | "failed";
  detail?: string;
}

export interface FanoutDeps {
  members?: readonly MemberId[];
  /** The member's own Gmail only (see lib/gmail/drafts.ts). */
  createDraft(memberId: MemberId, msg: { to?: string; subject: string; body: string }): Promise<{ status: "created"; draftId: string; threadId?: string } | { status: "not_authorized" } | { status: "reauth_required" } | { status: "failed"; reason: string }>;
  isConnected(memberId: MemberId): Promise<boolean>;
  /** Draft text for this member (Nemotron, written as that member). */
  compose(memberId: MemberId, memberName: string): Promise<DraftContent>;
  ledger: {
    get(key: string): Promise<{ status: string } | undefined>;
    record(entry: { draftKey: string; memberId: MemberId; itemType: DraftItemType; itemId: string; gmailDraftId: string; threadId?: string; status: "created" | "skipped_unauthorized" | "failed"; detail: string }): Promise<void>;
  };
}

export const draftKey = (item: Pick<FanoutItem, "type" | "id">, memberId: MemberId) => `${item.type}:${item.id}:${memberId}`;

export async function distributeDrafts(item: FanoutItem, deps: FanoutDeps): Promise<MemberDraftOutcome[]> {
  const outcomes: MemberDraftOutcome[] = [];
  for (const memberId of deps.members ?? MEMBER_IDS) {
    const key = draftKey(item, memberId);
    try {
      if ((await deps.ledger.get(key))?.status === "created") {
        outcomes.push({ memberId, result: "already_drafted" });
        continue;
      }
      if (!(await deps.isConnected(memberId))) {
        await deps.ledger.record({ draftKey: key, memberId, itemType: item.type, itemId: item.id, gmailDraftId: "", status: "skipped_unauthorized", detail: "Gmail not connected" });
        outcomes.push({ memberId, result: "not_authorized" });
        continue;
      }
      const content = await deps.compose(memberId, getMember(memberId)?.name ?? memberId);
      const res = await deps.createDraft(memberId, { ...(item.to ? { to: item.to } : {}), subject: content.subject, body: content.body });
      if (res.status === "created") {
        await deps.ledger.record({ draftKey: key, memberId, itemType: item.type, itemId: item.id, gmailDraftId: res.draftId, ...(res.threadId ? { threadId: res.threadId } : {}), status: "created", detail: "" });
        outcomes.push({ memberId, result: "created" });
      } else if (res.status === "failed") {
        await deps.ledger.record({ draftKey: key, memberId, itemType: item.type, itemId: item.id, gmailDraftId: "", status: "failed", detail: res.reason });
        outcomes.push({ memberId, result: "failed", detail: res.reason });
      } else {
        await deps.ledger.record({ draftKey: key, memberId, itemType: item.type, itemId: item.id, gmailDraftId: "", status: "skipped_unauthorized", detail: res.status });
        outcomes.push({ memberId, result: res.status });
      }
    } catch (err) {
      // One member's problem (e.g. Nemotron down while writing their draft) never blocks the others.
      const detail = err instanceof Error ? err.name : "error";
      await deps.ledger.record({ draftKey: key, memberId, itemType: item.type, itemId: item.id, gmailDraftId: "", status: "failed", detail }).catch(() => undefined);
      outcomes.push({ memberId, result: "failed", detail });
    }
  }
  return outcomes;
}
