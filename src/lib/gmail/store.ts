import "server-only";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { getSheetsClient } from "@/lib/google-sheets/client";
import { withWriteLock } from "@/lib/google-sheets/lock";
import { rowRange, tableRange } from "@/lib/google-sheets/schema";
import { invalidateTableCache, readTable } from "@/lib/google-sheets/table";

/**
 * Persistence for Gmail connections (NF_GmailAccounts) and the per-member draft ledger (NF_Drafts), in
 * the existing JobSync spreadsheet. Refresh tokens are stored ENCRYPTED only (see crypto.ts); nothing here
 * ever touches the Connections tab.
 */
export type GmailStatus = "connected" | "reauth_required" | "disconnected";

export interface GmailAccountRecord {
  row: number;
  memberId: MemberId;
  email: string;
  refreshTokenEnc: string;
  scope: string;
  status: GmailStatus;
  connectedAt: string;
  updatedAt: string;
  lastError: string;
}

const STATUSES: readonly GmailStatus[] = ["connected", "reauth_required", "disconnected"];

export async function readGmailAccounts(options: { fresh?: boolean } = {}): Promise<GmailAccountRecord[]> {
  const rows = await readTable("nfGmailAccounts", options);
  const out: GmailAccountRecord[] = [];
  for (const { row, cells } of rows) {
    const [memberId, email, refreshTokenEnc, scope, status, connectedAt, updatedAt, lastError] = cells.map((c) => c.trim());
    if (!(MEMBER_IDS as readonly string[]).includes(memberId) || !(STATUSES as readonly string[]).includes(status)) continue;
    out.push({ row, memberId: memberId as MemberId, email, refreshTokenEnc, scope, status: status as GmailStatus, connectedAt, updatedAt, lastError });
  }
  return out;
}

const serialize = (r: Omit<GmailAccountRecord, "row">) => [r.memberId, r.email, r.refreshTokenEnc, r.scope, r.status, r.connectedAt, r.updatedAt, r.lastError];

/** Inserts or replaces the ONE row of `memberId` (the last write wins; other members' rows are never touched). */
export async function upsertGmailAccount(rec: Omit<GmailAccountRecord, "row">): Promise<void> {
  await withWriteLock(async () => {
    const existing = (await readGmailAccounts({ fresh: true })).find((r) => r.memberId === rec.memberId);
    try {
      if (existing) await getSheetsClient().updateValues(rowRange("nfGmailAccounts", existing.row), [serialize(rec)]);
      else await getSheetsClient().appendValues(tableRange("nfGmailAccounts"), [serialize(rec)]);
    } finally {
      invalidateTableCache();
    }
  });
}

export async function updateGmailStatus(memberId: MemberId, status: GmailStatus, lastError: string, nowIso: string, clearToken = false): Promise<void> {
  await withWriteLock(async () => {
    const existing = (await readGmailAccounts({ fresh: true })).find((r) => r.memberId === memberId);
    if (!existing) return;
    const next = { ...existing, status, lastError, updatedAt: nowIso, ...(clearToken ? { refreshTokenEnc: "" } : {}) };
    try {
      await getSheetsClient().updateValues(rowRange("nfGmailAccounts", existing.row), [serialize(next)]);
    } finally {
      invalidateTableCache();
    }
  });
}

// ---- draft ledger ---------------------------------------------------------------------------------------

export type DraftStatus = "created" | "sent" | "deleted" | "skipped_unauthorized" | "failed";

export interface DraftRecord {
  draftKey: string;
  memberId: MemberId;
  itemType: string;
  itemId: string;
  gmailDraftId: string;
  status: DraftStatus;
  createdAt: string;
  detail: string;
  /** Gmail thread of the draft (used to tell "sent" from "deleted" later). */
  threadId?: string;
  /** Last time the draft's fate was checked. */
  checkedAt?: string;
}

export async function readDraftLedger(options: { fresh?: boolean } = {}): Promise<Map<string, DraftRecord & { row: number }>> {
  const rows = await readTable("nfDrafts", options);
  const out = new Map<string, DraftRecord & { row: number }>();
  for (const { row, cells } of rows) {
    const [draftKey, memberId, itemType, itemId, gmailDraftId, status, createdAt, detail, threadId, checkedAt] = cells.map((c) => c.trim());
    if (!draftKey || !(MEMBER_IDS as readonly string[]).includes(memberId)) continue;
    if (!out.has(draftKey)) out.set(draftKey, { row, draftKey, memberId: memberId as MemberId, itemType, itemId, gmailDraftId, status: status as DraftStatus, createdAt, detail, ...(threadId ? { threadId } : {}), ...(checkedAt ? { checkedAt } : {}) });
  }
  return out;
}

const serializeDraft = (r: DraftRecord) => [r.draftKey, r.memberId, r.itemType, r.itemId, r.gmailDraftId, r.status, r.createdAt, r.detail, r.threadId ?? "", r.checkedAt ?? ""];

export async function recordDraft(rec: DraftRecord): Promise<void> {
  await withWriteLock(async () => {
    const existing = (await readDraftLedger({ fresh: true })).get(rec.draftKey);
    try {
      if (existing) await getSheetsClient().updateValues(rowRange("nfDrafts", existing.row), [serializeDraft(rec)]);
      else await getSheetsClient().appendValues(tableRange("nfDrafts"), [serializeDraft(rec)]);
    } finally {
      invalidateTableCache();
    }
  });
}
