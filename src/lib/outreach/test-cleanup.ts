/**
 * Removes the artefacts of the CONTROLLED outreach test (ten labelled contacts sent only to `<local>+jobsyncNN@<domain>`), and nothing else.
 *
 * Safety model: every row is selected by a positive identification, never by a pattern that real data could match.
 *  - A Connection is a test Connection only if its address is one of the ten generated test addresses AND its notes carry the import marker
 *    `Source: Outreach Database HRC-<id>` with the matching generated test ContactID.
 *  - A draft is removed only if it belongs to such a Connection. Only UNSENT Gmail drafts are deleted; sent messages are never touched.
 *  - Tracking / send-ledger rows are removed only for the generated test ContactIDs / addresses.
 *  - Shared milestone state and counters are removed only when no real tracking row exists at all.
 * It runs on the server (production credentials) because Gmail drafts can only be deleted with each member's own authorisation.
 * It is idempotent and stops without deleting anything further when a Gmail draft cannot be deleted, so it can simply be re-run.
 */
import type { MemberId } from "@/config/members";
import type { SheetsClient } from "@/lib/google-sheets/client";
import { contactIdFor } from "@/lib/hr-master/ids";
import type { Connection } from "@/types/domain";
import { recipientOfKey } from "./send-ledger";
import { OutreachSheet } from "./sheet";
import { COUNTERS_TAB, SEND_LEDGER_TAB, STATE_TAB, TRACKING_TAB } from "./types";

/** `me+jobsync01@gmail.com` ... `me+jobsync10@gmail.com`. */
export const testEmail = (local: string, domain: string, i: number) => `${local}+jobsync${String(i).padStart(2, "0")}@${domain}`.toLowerCase();
export const testContactIds = (local: string, domain: string) => new Set(Array.from({ length: 10 }, (_, i) => contactIdFor(testEmail(local, domain, i + 1))));
export const testEmails = (local: string, domain: string) => new Set(Array.from({ length: 10 }, (_, i) => testEmail(local, domain, i + 1)));

export interface CleanupPorts {
  local: string;
  domain: string;
  /** The Outreach Database spreadsheet. */
  outreach: SheetsClient;
  /** The production JobSync Database spreadsheet (draft-ledger rows only). */
  prod: SheetsClient;
  listConnections(): Promise<Connection[]>;
  deleteConnection(owner: MemberId, connectionId: string): Promise<void>;
  /** Deletes one Gmail DRAFT in the member's own mailbox; "gone" if it no longer exists. */
  deleteGmailDraft(member: MemberId, draftId: string): Promise<"deleted" | "gone" | "error">;
  /** Count what would be removed without removing anything. */
  dryRun?: boolean;
}

export interface CleanupReport {
  dryRun: boolean;
  connectionsDeleted: number;
  gmailDraftsDeleted: number;
  gmailDraftErrors: number;
  draftLedgerRowsDeleted: number;
  trackingRowsDeleted: number;
  sendLedgerRowsDeleted: number;
  stateRowsDeleted: number;
  counterRowsDeleted: number;
  /** Sent drafts (messages already delivered): their ledger rows go, the messages in Gmail are never touched. */
  sentDraftsKept: number;
  /** Real (non-test) tracking rows found: when > 0 the shared state / counter rows are kept. */
  realTrackingRowsRemaining: number;
}

const NOTE_ID = /Source: Outreach Database (HRC-[0-9A-F]{12})/;

export async function cleanupTestArtifacts(p: CleanupPorts): Promise<CleanupReport> {
  const dry = p.dryRun === true;
  const ids = testContactIds(p.local, p.domain);
  const emails = testEmails(p.local, p.domain);
  const report: CleanupReport = { dryRun: dry, connectionsDeleted: 0, gmailDraftsDeleted: 0, gmailDraftErrors: 0, draftLedgerRowsDeleted: 0, trackingRowsDeleted: 0, sendLedgerRowsDeleted: 0, stateRowsDeleted: 0, counterRowsDeleted: 0, sentDraftsKept: 0, realTrackingRowsRemaining: 0 };
  const sheet = new OutreachSheet(p.outreach);

  // 1. The test Connections: the address AND the import marker with a test ContactID must both match.
  const connections = (await p.listConnections()).filter((c) => emails.has((c.email ?? "").toLowerCase()) && ids.has(NOTE_ID.exec(c.notes ?? "")?.[1] ?? ""));
  const connectionIds = new Set(connections.map((c) => c.connectionId));

  // 2. Their UNSENT Gmail drafts (every member's mailbox), then their draft-ledger rows.
  const ledger = await p.prod.getValues("NF_Drafts!A:J");
  const ledgerRows: number[] = [];
  for (let i = 1; i < ledger.length; i++) {
    const [key, member, , itemId, draftId, status] = ledger[i];
    if (!connectionIds.has(itemId ?? "") || !String(key ?? "").startsWith("contact:")) continue;
    ledgerRows.push(i + 1);
    if (status === "sent") report.sentDraftsKept += 1;
    if (status === "created" && draftId) {
      if (dry) { report.gmailDraftsDeleted += 1; continue; }
      const r = await p.deleteGmailDraft(member as MemberId, draftId);
      if (r === "error") report.gmailDraftErrors += 1;
      else if (r === "deleted") report.gmailDraftsDeleted += 1;
    }
  }
  // If any Gmail draft could not be deleted, STOP here: keep every record that still points at it so the cleanup can simply be re-run.
  if (report.gmailDraftErrors > 0) return report;
  if (ledgerRows.length) {
    if (!dry) await p.prod.deleteRows("NF_Drafts", ledgerRows);
    report.draftLedgerRowsDeleted = ledgerRows.length;
  }

  // 3. The Connections themselves (through the application's own delete, owner by owner).
  for (const c of connections) {
    if (!dry) await p.deleteConnection(c.memberId, c.connectionId);
    report.connectionsDeleted += 1;
  }

  // 4. Outreach Database bookkeeping: tracking rows, send-ledger rows, then (only if nothing real remains) milestone state and counters.
  const tracking = (await sheet.readTracking()).records;
  const mine = tracking.filter((t) => ids.has(t.contactId));
  if (mine.length) {
    if (!dry) await p.outreach.deleteRows(TRACKING_TAB, mine.map((t) => t.row));
    report.trackingRowsDeleted = mine.length;
  }
  report.realTrackingRowsRemaining = tracking.length - mine.length;

  // Send keys are `member|recipient` (the earlier recipient-only form is recognised too).
  const sends = (await sheet.readSendLedger()).records.filter((r) => emails.has(recipientOfKey(r.sendKey)));
  if (sends.length) {
    if (!dry) await p.outreach.deleteRows(SEND_LEDGER_TAB, sends.map((r) => r.row));
    report.sendLedgerRowsDeleted = sends.length;
  }

  if (report.realTrackingRowsRemaining === 0) {
    const state = await p.outreach.getValues(`'${STATE_TAB}'!A:C`);
    const stateRows = state.map((r, i) => ({ i, key: (r[0] ?? "").trim() })).filter((r) => r.i > 0 && /^(lost:|released:|stale:)?(milestone:(connections|emails):\d+|connections-announced|emails-announced)$/.test(r.key)).map((r) => r.i + 1);
    if (stateRows.length && !dry) await p.outreach.deleteRows(STATE_TAB, stateRows);
    report.stateRowsDeleted = stateRows.length;
    const counters = await p.outreach.getValues(`'${COUNTERS_TAB}'!A:A`);
    const counterRows = counters.map((r, i) => ({ i, day: (r[0] ?? "").trim() })).filter((r) => r.i > 0 && r.day).map((r) => r.i + 1);
    if (counterRows.length && !dry) await p.outreach.deleteRows(COUNTERS_TAB, counterRows);
    report.counterRowsDeleted = counterRows.length;
  }
  return report;
}
