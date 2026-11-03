import "server-only";
import type { MemberId } from "@/config/members";
import { loadOutreachConfig } from "@/lib/outreach/config";
import { openOutreachSheet } from "@/lib/outreach/run";
import { draftListFor, type DraftList } from "./draft-list";

/**
 * The Draft / Sent counters shown on the Gmail drafts page.
 *
 * SENT counts ONLY e-mails that JobSync's automated sending workflow sent: JobSync itself called the Gmail send API, Gmail confirmed
 * success (a message id and the SENT label), and the Outreach Send Ledger recorded that confirmed result. A ledger row counts only when
 * its status is "sent" AND it carries the Gmail message id. Each recipient counts once per member (the ledger key is the normalised
 * recipient address), so a send that is also mirrored in other JobSync records (the draft ledger, the Connection's "Messaged" status,
 * the tracking tab) is never counted twice.
 *
 * NOT counted, by design: drafts; claimed / sending / pending / failed / uncertain / superseded / released / review rows; JobSync drafts
 * that a member sends by hand from Gmail; every e-mail sent outside JobSync. The draft ledger and Gmail's Sent folder are NEVER a source
 * for this counter, whatever GMAIL_TRACK_SENT is set to. A member's counters are computed from that member's own ledger rows only.
 *
 * The DRAFT counter is unchanged: JobSync drafts still waiting in the member's Gmail (a draft the member sent by hand, or one JobSync sent,
 * is no longer a waiting draft).
 */
export interface MemberCounters {
  drafted: number;
  sent: number;
}

export interface SendLedgerRow {
  member: string;
  /** Normalised recipient address: the ledger's idempotency key. */
  sendKey: string;
  connectionId: string;
  status: string;
  /** Gmail's id of the sent message (proof that Gmail confirmed the send). */
  gmailMessageId: string;
}

export type SendLedgerReader = () => Promise<readonly SendLedgerRow[] | null>;

let readerOverride: SendLedgerReader | null | undefined;
/** Test hook: replace the Outreach Send Ledger reader (null = "not configured"; undefined restores the real one). */
export function setSendLedgerReaderForTesting(r: SendLedgerReader | null | undefined): void {
  readerOverride = r;
  cache = null;
}

let cache: { at: number; rows: readonly SendLedgerRow[] | null } | null = null;
const CACHE_MS = 15_000;

/** The Outreach Send Ledger, when the Outreach Database is configured; null otherwise (then nothing has been sent by automation). Cached briefly to spare Sheets quota. */
async function sendLedger(): Promise<readonly SendLedgerRow[] | null> {
  if (readerOverride !== undefined) return readerOverride ? readerOverride() : null;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  let rows: readonly SendLedgerRow[] | null = null;
  try {
    const cfg = loadOutreachConfig();
    if (cfg.spreadsheetId) {
      rows = (await openOutreachSheet(cfg).readSendLedger()).records.map((r) => ({ member: r.member, sendKey: r.sendKey, connectionId: r.connectionId, status: r.status, gmailMessageId: r.gmailMessageId }));
    }
  } catch {
    rows = null; // unreachable Outreach Database: keep the last value out of the count rather than guess
  }
  cache = { at: Date.now(), rows };
  return rows;
}

export interface AutomatedSent {
  /** Recipients counted (distinct per member). */
  count: number;
  /** The Connections they belong to (used only to show those rows as Sent in the table). */
  connectionIds: Set<string>;
}

/** Confirmed automated sends of ONE member, each recipient once. */
export async function automatedSentFor(memberId: MemberId): Promise<AutomatedSent> {
  const rows = (await sendLedger()) ?? [];
  const recipients = new Set<string>();
  const connectionIds = new Set<string>();
  for (const r of rows) {
    if (r.member !== memberId || r.status !== "sent" || !r.gmailMessageId.trim()) continue; // confirmed AND proven by Gmail's message id
    recipients.add(r.sendKey || r.connectionId);
    if (r.connectionId) connectionIds.add(r.connectionId);
  }
  return { count: recipients.size, connectionIds };
}

/**
 * The member's Gmail drafts page data. `drafted` and the table are the unchanged draft view (a contact JobSync sent shows as Sent and is
 * no longer a waiting draft); `sent` is the automated-send count above and nothing else.
 */
export async function draftsWithSent(memberId: MemberId): Promise<DraftList> {
  const auto = await automatedSentFor(memberId);
  const list = await draftListFor(memberId, auto.connectionIds);
  return { ...list, sent: auto.count };
}

export async function countersFor(memberId: MemberId): Promise<MemberCounters> {
  const list = await draftsWithSent(memberId);
  return { drafted: list.drafted, sent: list.sent };
}
