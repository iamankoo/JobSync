import "server-only";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { DomainError } from "@/lib/google-sheets/errors";
import { readConnectionsLocated } from "@/lib/google-sheets/repositories";
import { draftKey } from "@/lib/network-finder/draft-fanout";
import { readDraftLedger } from "./store";

/**
 * Drafting state of one connection, derived from the draft ledger (NF_Drafts: one record per connection + member
 * mailbox). Every new connection with an email is drafted automatically into all three members' Gmail by the
 * scheduled worker (`runPendingDrafts`); this only REPORTS where that stands. No draft text, addresses or tokens.
 */
export type MailboxDraftStatus = "none" | "created" | "sent" | "skipped_unauthorized" | "failed" | "deleted";
export type ConnectionDraftState = "no_email" | "waiting" | "drafting" | "drafted";

export interface ConnectionDraftStatus {
  state: ConnectionDraftState;
  hasEmail: boolean;
  /** Mailboxes with a draft (unsent or sent). */
  drafted: number;
  sent: number;
  skipped: number;
  total: number;
  members: { memberId: MemberId; status: MailboxDraftStatus }[];
}

export async function connectionDraftStatus(connectionId: string): Promise<ConnectionDraftStatus> {
  const c = (await readConnectionsLocated()).items.find((i) => i.value.connectionId === connectionId)?.value;
  if (!c) throw new DomainError("connection_not_found", "Connection not found.");
  let ledger = new Map<string, { status: string }>();
  try {
    ledger = await readDraftLedger();
  } catch {
    // Draft tab missing / unreadable: report "waiting" rather than failing the details view.
  }
  const members = MEMBER_IDS.map((memberId) => ({ memberId, status: ((ledger.get(draftKey({ type: "contact", id: connectionId }, memberId))?.status as MailboxDraftStatus | undefined) ?? "none") }));
  const drafted = members.filter((m) => m.status === "created" || m.status === "sent").length;
  const sent = members.filter((m) => m.status === "sent").length;
  const skipped = members.filter((m) => m.status === "skipped_unauthorized").length;
  const hasEmail = Boolean(c.email?.trim());
  const anyRecord = members.some((m) => m.status !== "none");
  // Fully drafted only when EVERY mailbox is processed (a disconnected mailbox counts once it is recorded as skipped).
  const state: ConnectionDraftState = drafted + skipped === members.length ? "drafted" : anyRecord ? "drafting" : hasEmail ? "waiting" : "no_email";
  return { state, hasEmail, drafted, sent, skipped, total: members.length, members };
}
