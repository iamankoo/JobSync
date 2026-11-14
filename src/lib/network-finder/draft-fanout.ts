import { getMember, MEMBER_IDS, type MemberId } from "@/config/members";
import type { DraftAttachment } from "@/lib/gmail/attachment";
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
  /** "paused_backlog": too many unsent drafts are waiting in the members' Gmail (or the count is unavailable); nothing was composed, created or recorded. */
  result: "created" | "already_drafted" | "not_authorized" | "reauth_required" | "failed" | "paused_backlog";
  detail?: string;
}

/**
 * The draft-backlog gate (see lib/gmail/draft-backlog.ts), PER MEMBER. `check(member)` with `allowed: false` means no new draft may be started for
 * THAT member (their own Gmail holds 100+ unsent JobSync drafts, or cannot be counted); the other members' drafts are created as usual. The paused
 * member's draft for this item is simply not started (nothing is composed or recorded), so a later run creates it once they are below the limit.
 * It must fail closed. `check()` without a member answers "may ANY member draft".
 */
export interface BacklogGatePort {
  check(member?: MemberId): Promise<{ allowed: boolean; pending: number | null; reason: string }>;
  /** A draft was just created for `member`: counted at once (the next check does not wait for a fresh Gmail count). */
  noteCreated(count?: number, member?: MemberId): void;
}

export interface FanoutDeps {
  /** Present in production wiring for EVERY draft-creation path (Outreach and Network Finder both end in distributeDrafts). */
  backlog?: BacklogGatePort;
  members?: readonly MemberId[];
  /** The member's own Gmail only (see lib/gmail/drafts.ts). */
  createDraft(memberId: MemberId, msg: { to?: string; subject: string; body: string; attachment?: DraftAttachment }): Promise<{ status: "created"; draftId: string; threadId?: string; attachment?: "verified" | "unverified" } | { status: "not_authorized" } | { status: "reauth_required" } | { status: "failed"; reason: string }>;
  isConnected(memberId: MemberId): Promise<boolean>;
  /** Draft text for this member (Nemotron, written as that member). `memberName` is their full name (config/members.ts). */
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
      const previous = (await deps.ledger.get(key))?.status;
      // A draft that exists, or was already SENT, is never written again.
      if (previous === "created" || previous === "sent") {
        outcomes.push({ memberId, result: "already_drafted" });
        continue;
      }
      if (deps.backlog) {
        // THIS member's own backlog. Fail closed: a gate that cannot answer (or throws) pauses this member's drafting rather than risk growing it.
        const verdict = await deps.backlog.check(memberId).catch(() => ({ allowed: false, pending: null, reason: "draft backlog could not be checked" }));
        if (!verdict.allowed) {
          outcomes.push({ memberId, result: "paused_backlog", detail: verdict.reason });
          continue;
        }
      }
      if (!(await deps.isConnected(memberId))) {
        // Recorded once; retried automatically once the member connects Gmail.
        if (previous !== "skipped_unauthorized") await deps.ledger.record({ draftKey: key, memberId, itemType: item.type, itemId: item.id, gmailDraftId: "", status: "skipped_unauthorized", detail: "Gmail not connected" });
        outcomes.push({ memberId, result: "not_authorized" });
        continue;
      }
      // Written and signed with the member's full name; the draft is still created in THEIR OWN Gmail only.
      const content = await deps.compose(memberId, getMember(memberId)?.fullName ?? memberId);
      const res = await deps.createDraft(memberId, { ...(item.to ? { to: item.to } : {}), subject: content.subject, body: content.body, ...(content.attachment ? { attachment: content.attachment } : {}) });
      if (res.status === "created") {
        // The attachment counts as done only when the saved draft was read back with the file in it; otherwise the draft
        // (which exists, and is never rewritten) is flagged for the member.
        const attachNote = content.attachment ? (res.attachment === "verified" ? `attached: ${content.attachment.fileName}` : "review: resume attachment could not be verified in the saved draft") : "";
        const detail = [content.review, content.note, attachNote].filter(Boolean).join("; ");
        await deps.ledger.record({ draftKey: key, memberId, itemType: item.type, itemId: item.id, gmailDraftId: res.draftId, ...(res.threadId ? { threadId: res.threadId } : {}), status: "created", detail });
        deps.backlog?.noteCreated(1, memberId);
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
