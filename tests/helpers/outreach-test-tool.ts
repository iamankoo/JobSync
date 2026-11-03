/**
 * Tooling for a CONTROLLED live test of the outreach pipeline: generates 10 clearly labelled test contacts for an isolated tab, and
 * removes every artefact of the test afterwards. The cleanup can only touch rows that provably belong to the test (their ContactIDs /
 * addresses are derived from the generated contacts); real rows are never selected.
 */
import type { MemberId } from "@/config/members";
import { contactIdFor } from "@/lib/hr-master/ids";
import { OutreachSheet } from "@/lib/outreach/sheet";
import { COUNTERS_TAB, SEND_LEDGER_TAB, STATE_TAB, TRACKING_TAB } from "@/lib/outreach/types";
import type { SheetsClient } from "@/lib/google-sheets/client";
import type { Connection } from "@/types/domain";
import { masterRow } from "./outreach";

export const TEST_TAB = "Test Contacts";
export const TEST_LABEL = "TEST ENTRY";

const ROLES = [
  "AI Engineer", "AI/ML Engineer", "Software Engineer", "Software Engineer", "Backend Engineer",
  "Full Stack Engineer", "Front End Developer / Engineer", "Data Engineer", "Software Engineer", "Software Engineer",
] as const;

/** `me+jobsync01@gmail.com` ... `me+jobsync10@gmail.com`. */
export const testEmail = (local: string, domain: string, i: number) => `${local}+jobsync${String(i).padStart(2, "0")}@${domain}`.toLowerCase();

/**
 * Ten test contacts. Names and companies are labelled "JobSync Test NN" / "JobSync TEST Company NN". Contact 09 has no person name
 * (exercises "Hiring Team") and contact 10 has no company (exercises "your company"). Roles vary so several resume kinds are exercised.
 */
export function buildTestContactRows(local: string, domain: string): string[][] {
  return ROLES.map((role, k) => {
    const n = k + 1;
    const nn = String(n).padStart(2, "0");
    return masterRow({
      PersonEmail: testEmail(local, domain, n),
      PersonName: n === 9 ? "" : `JobSync Test ${nn}`,
      PersonDesignation: `${TEST_LABEL} - recruiter`,
      CompanyName: n === 10 ? "" : `JobSync TEST Company ${nn}`,
      CompanyDescription: n === 10 ? "" : `${TEST_LABEL} created to verify JobSync outreach; safe to delete.`,
      PrimaryRoleCategory: role,
      RoleBasis: "default-fallback",
      ResearchNotes: `${TEST_LABEL}: controlled test of the outreach pipeline`,
      EmailKind: "public-provider",
    });
  });
}

export const testContactIds = (local: string, domain: string) => new Set(Array.from({ length: 10 }, (_, i) => contactIdFor(testEmail(local, domain, i + 1))));
export const testEmails = (local: string, domain: string) => new Set(Array.from({ length: 10 }, (_, i) => testEmail(local, domain, i + 1)));

export interface CleanupPorts {
  local: string;
  domain: string;
  /** The Outreach Database spreadsheet. */
  outreach: SheetsClient;
  /** The production JobSync Database spreadsheet (draft ledger rows only). */
  prod: SheetsClient;
  listConnections(): Promise<Connection[]>;
  deleteConnection(owner: MemberId, connectionId: string): Promise<void>;
  /** Deletes one Gmail DRAFT in the member's own mailbox; "gone" if it no longer exists. */
  deleteGmailDraft(member: MemberId, draftId: string): Promise<"deleted" | "gone" | "error">;
}

export interface CleanupReport {
  connectionsDeleted: number;
  gmailDraftsDeleted: number;
  gmailDraftErrors: number;
  draftLedgerRowsDeleted: number;
  trackingRowsDeleted: number;
  sendLedgerRowsDeleted: number;
  stateRowsDeleted: number;
  counterRowsDeleted: number;
  /** Real (non-test) tracking rows found: when > 0 the shared state / counter rows are kept. */
  realTrackingRowsRemaining: number;
}

const NOTE_ID = /Source: Outreach Database (HRC-[0-9A-F]{12})/;

export async function cleanupTestArtifacts(p: CleanupPorts): Promise<CleanupReport> {
  const ids = testContactIds(p.local, p.domain);
  const emails = testEmails(p.local, p.domain);
  const report: CleanupReport = { connectionsDeleted: 0, gmailDraftsDeleted: 0, gmailDraftErrors: 0, draftLedgerRowsDeleted: 0, trackingRowsDeleted: 0, sendLedgerRowsDeleted: 0, stateRowsDeleted: 0, counterRowsDeleted: 0, realTrackingRowsRemaining: 0 };
  const sheet = new OutreachSheet(p.outreach);

  // 1. The test Connections: the address AND the import marker with a test ContactID must both match.
  const connections = (await p.listConnections()).filter((c) => emails.has((c.email ?? "").toLowerCase()) && ids.has(NOTE_ID.exec(c.notes ?? "")?.[1] ?? ""));
  const connectionIds = new Set(connections.map((c) => c.connectionId));

  // 2. Their Gmail drafts (every member's mailbox), then their draft-ledger rows.
  const ledger = await p.prod.getValues("NF_Drafts!A:J");
  const ledgerRows: number[] = [];
  for (let i = 1; i < ledger.length; i++) {
    const [key, member, , itemId, draftId, status] = ledger[i];
    if (!connectionIds.has(itemId ?? "") || !String(key ?? "").startsWith("contact:")) continue;
    ledgerRows.push(i + 1);
    if (status === "created" && draftId) {
      const r = await p.deleteGmailDraft(member as MemberId, draftId);
      if (r === "error") report.gmailDraftErrors += 1;
      else if (r === "deleted") report.gmailDraftsDeleted += 1;
    }
  }
  // If any Gmail draft could not be deleted, STOP here: keep every record that still points at it so the cleanup can simply be re-run.
  if (report.gmailDraftErrors > 0) return report;
  if (ledgerRows.length) {
    await p.prod.deleteRows("NF_Drafts", ledgerRows);
    report.draftLedgerRowsDeleted = ledgerRows.length;
  }

  // 3. The Connections themselves (through the application's own delete, owner by owner).
  for (const c of connections) {
    await p.deleteConnection(c.memberId, c.connectionId);
    report.connectionsDeleted += 1;
  }

  // 4. Outreach Database bookkeeping: tracking rows, send-ledger rows, then (only if nothing real remains) milestone state and counters.
  const tracking = (await sheet.readTracking()).records;
  const mine = tracking.filter((t) => ids.has(t.contactId));
  if (mine.length) {
    await p.outreach.deleteRows(TRACKING_TAB, mine.map((t) => t.row));
    report.trackingRowsDeleted = mine.length;
  }
  report.realTrackingRowsRemaining = tracking.length - mine.length;

  const sends = (await sheet.readSendLedger()).records.filter((r) => emails.has(r.sendKey));
  if (sends.length) {
    await p.outreach.deleteRows(SEND_LEDGER_TAB, sends.map((r) => r.row));
    report.sendLedgerRowsDeleted = sends.length;
  }

  if (report.realTrackingRowsRemaining === 0) {
    const state = await p.outreach.getValues(`'${STATE_TAB}'!A:C`);
    const stateRows = state.map((r, i) => ({ i, key: (r[0] ?? "").trim() })).filter((r) => r.i > 0 && /^(lost:|released:|stale:)?(milestone:(connections|emails):\d+|connections-announced|emails-announced)$/.test(r.key)).map((r) => r.i + 1);
    if (stateRows.length) await p.outreach.deleteRows(STATE_TAB, stateRows);
    report.stateRowsDeleted = stateRows.length;
    const counters = await p.outreach.getValues(`'${COUNTERS_TAB}'!A:A`);
    const counterRows = counters.map((r, i) => ({ i, day: (r[0] ?? "").trim() })).filter((r) => r.i > 0 && r.day).map((r) => r.i + 1);
    if (counterRows.length) await p.outreach.deleteRows(COUNTERS_TAB, counterRows);
    report.counterRowsDeleted = counterRows.length;
  }
  return report;
}
