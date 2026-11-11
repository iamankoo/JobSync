/**
 * Persistence for the outreach pipeline: the Outreach Database spreadsheet (a SEPARATE file from the production JobSync
 * Database). It reads Master Contacts and keeps three small tabs of its own. It never touches the production spreadsheet and
 * never deletes or rewrites Master Contacts rows.
 */
import { randomUUID } from "node:crypto";
import { SheetsError } from "@/lib/google-sheets/errors";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import type { SheetsClient } from "@/lib/google-sheets/client";
import { columnLetter } from "@/lib/google-sheets/schema";
import { COUNTERS_TAB, EXCLUSIONS_TAB, MASTER_TAB, PRIORITY_TAB, SEND_LEDGER_TAB, STATE_TAB, TRACKING_TAB, emptyDrafts, type DailyCounters, type ImportStatus, type ProcessingStatus, type Segment, type SendLedgerStatus, type SendRecord, type SendStatus, type TrackingRecord } from "./types";

import { COUNTER_HEADERS, EXCLUSION_HEADERS, SEND_LEDGER_HEADERS, STATE_HEADERS, TRACKING_HEADERS } from "./headers";
export { COUNTER_HEADERS, EXCLUSION_HEADERS, SEND_LEDGER_HEADERS, STATE_HEADERS, TRACKING_HEADERS };

const HEADERS: Record<string, readonly string[]> = { [TRACKING_TAB]: TRACKING_HEADERS, [COUNTERS_TAB]: COUNTER_HEADERS, [STATE_TAB]: STATE_HEADERS, [SEND_LEDGER_TAB]: SEND_LEDGER_HEADERS, [EXCLUSIONS_TAB]: EXCLUSION_HEADERS };
/** A milestone claim that was never completed (the process died) may be claimed again after this long. */
export const MILESTONE_CLAIM_TTL_MS = 10 * 60_000;
const q = (tab: string) => `'${tab}'`;

/** Master Contacts is static (15,891 rows x 32 columns) but every cron call used to read it 3 times. Warm serverless instances reuse it for this long. */
export const MASTER_CACHE_TTL_MS = 20 * 60_000;
const masterCache = new Map<string, { at: number; grid: string[][] }>();
/** The optional Priority Contacts tab is small and edited by hand: a short cache keeps it cheap while a change shows up within minutes. */
export const PRIORITY_CACHE_TTL_MS = 5 * 60_000;
const priorityCache = new Map<string, { at: number; grid: string[][] }>();
/** Tabs and headers do not change between cron calls; verifying them costs 5 reads, so a warm instance re-checks only every 10 minutes. */
const TABS_OK_TTL_MS = 10 * 60_000;
const tabsVerified = new Map<string, number>();
export const clearMasterCache = () => { masterCache.clear(); priorityCache.clear(); tabsVerified.clear(); };
const lastCol = (tab: string) => columnLetter(HEADERS[tab].length);

const IMPORT_STATUSES: readonly ImportStatus[] = ["importing", "added", "import_failed"];
const PROCESSING: readonly ProcessingStatus[] = ["awaiting", "drafting", "drafted", "needs_review", "failed", "sent"];
const SEND_STATUSES: readonly SendStatus[] = ["disabled", "pending", "blocked", "review", "claimed", "sent", "uncertain", "failed"];
const LEDGER_STATUSES: readonly SendLedgerStatus[] = ["claimed", "sending", "sent", "uncertain", "failed_transient", "failed_permanent", "needs_review", "superseded", "released"];
const SEGMENTS: readonly Segment[] = ["person-and-company", "company-only", "person-only", "neither"];

export function serializeTracking(r: TrackingRecord): string[] {
  const d = r.drafts;
  return [
    r.contactId, r.email, r.source, r.importStatus, r.connectionId, r.ownerMemberId, r.importDay, r.claimedAt, r.addedAt, String(r.attempts),
    r.segment, r.targetRole, r.roleBasis, r.processing,
    d.anni.status, d.lukky.status, d.rishii.status, d.anni.resume, d.lukky.resume, d.rishii.resume,
    r.reviewReason, r.sendStatus, r.sentAt, r.lastError, r.updatedAt,
    r.sendBlockReason, r.sentBy, r.gmailAccount, r.gmailMessageId, r.resumeSent, String(r.sendAttempts),
  ];
}

export function parseTracking(cells: readonly string[], row: number): TrackingRecord | null {
  const c = (i: number) => (cells[i] ?? "").toString().trim();
  const importStatus = c(3) as ImportStatus;
  if (!c(0) || !(IMPORT_STATUSES as readonly string[]).includes(importStatus)) return null;
  const drafts = emptyDrafts();
  MEMBER_IDS.forEach((m, i) => {
    drafts[m] = { status: c(14 + i), resume: c(17 + i) };
  });
  const processing = (PROCESSING as readonly string[]).includes(c(13)) ? (c(13) as ProcessingStatus) : "awaiting";
  return {
    row, contactId: c(0), email: c(1), source: c(2) === "manual" ? "manual" : c(2) === "existing-draft" ? "existing-draft" : "outreach-database", importStatus, connectionId: c(4), ownerMemberId: c(5),
    importDay: c(6), claimedAt: c(7), addedAt: c(8), attempts: Number(c(9)) || 0,
    segment: (SEGMENTS as readonly string[]).includes(c(10)) ? (c(10) as Segment) : "neither", targetRole: c(11), roleBasis: c(12), processing, drafts,
    reviewReason: c(20), sendStatus: (SEND_STATUSES as readonly string[]).includes(c(21)) ? (c(21) as SendStatus) : "disabled", sentAt: c(22), lastError: c(23), updatedAt: c(24),
    sendBlockReason: c(25), sentBy: c(26), gmailAccount: c(27), gmailMessageId: c(28), resumeSent: c(29), sendAttempts: Number(c(30)) || 0,
  };
}

export class OutreachSheet {
  constructor(
    private readonly client: SheetsClient,
    private readonly masterTab: string = MASTER_TAB,
    /** When set (production: the spreadsheet id), Master Contacts reads are cached under this key. Tests leave it unset. */
    private readonly cacheKey?: string,
  ) {}

  /** Verifies the three tracking tabs exist with the right headers (writing the header row only into a blank tab). */
  async ensureTabs(): Promise<void> {
    const verifiedAt = this.cacheKey ? tabsVerified.get(this.cacheKey) : undefined;
    if (verifiedAt !== undefined && Date.now() - verifiedAt < TABS_OK_TTL_MS) return;
    for (const [tab, headers] of Object.entries(HEADERS)) {
      let first: string[] | undefined;
      try {
        first = (await this.client.getValues(`${q(tab)}!1:1`))[0];
      } catch {
        throw new Error(`The Outreach Database has no tab named "${tab}". Run scripts/outreach/setup-outreach-tabs.mts once.`);
      }
      if (!first || first.every((c) => !c.trim())) {
        await this.client.updateValues(`${q(tab)}!A1:${columnLetter(headers.length)}1`, [[...headers]]);
      } else if (headers.some((h, i) => (first![i] ?? "").trim() !== "" && (first![i] ?? "").trim() !== h)) {
        throw new Error(`Tab "${tab}" in the Outreach Database does not have the expected header row.`);
      } else if (headers.some((h, i) => (first![i] ?? "").trim() !== h)) {
        // An older header that is a strict prefix of the expected one: extend it (additive, rows are untouched).
        await this.client.updateValues(`${q(tab)}!A1:${columnLetter(headers.length)}1`, [[...headers]]);
      }
    }
    if (this.cacheKey) tabsVerified.set(this.cacheKey, Date.now());
  }

  async readMaster(): Promise<string[][]> {
    const key = this.cacheKey ? `${this.cacheKey}|${this.masterTab}` : "";
    const hit = key ? masterCache.get(key) : undefined;
    if (hit && Date.now() - hit.at < MASTER_CACHE_TTL_MS) return hit.grid;
    const grid = await this.client.getValues(`${q(this.masterTab)}!A:AZ`);
    if (key) masterCache.set(key, { at: Date.now(), grid });
    return grid;
  }

  /**
   * The optional Priority Contacts tab (same columns as Master Contacts). A spreadsheet without that tab simply has no priority list: the read answers
   * [] (the tab is never created here). Any other failure (quota, network) is NOT mistaken for "no list": it is thrown.
   */
  async readPriority(): Promise<string[][]> {
    const key = this.cacheKey ? `${this.cacheKey}|${PRIORITY_TAB}` : "";
    const hit = key ? priorityCache.get(key) : undefined;
    if (hit && Date.now() - hit.at < PRIORITY_CACHE_TTL_MS) return hit.grid;
    let grid: string[][];
    try {
      grid = await this.client.getValues(`${q(PRIORITY_TAB)}!A:AZ`);
    } catch (err) {
      if (!(err instanceof SheetsError && err.code === "schema_invalid")) throw err;
      grid = [];
    }
    if (key) priorityCache.set(key, { at: Date.now(), grid });
    return grid;
  }

  async readTracking(): Promise<{ records: TrackingRecord[]; nextRow: number }> {
    const grid = await this.client.getValues(`${q(TRACKING_TAB)}!A:${lastCol(TRACKING_TAB)}`);
    const records: TrackingRecord[] = [];
    for (let i = 1; i < grid.length; i++) {
      const rec = parseTracking(grid[i], i + 1);
      if (rec) records.push(rec);
    }
    return { records, nextRow: Math.max(grid.length, 1) + 1 };
  }

  /** Appends a record at `row` (the first free row) and reads it back: it only counts as written once the read agrees. */
  async appendTracking(rec: TrackingRecord, row: number): Promise<TrackingRecord> {
    await this.client.appendValues(`${q(TRACKING_TAB)}!A:${lastCol(TRACKING_TAB)}`, [serializeTracking(rec)]);
    const back = (await this.client.getValues(`${q(TRACKING_TAB)}!A${row}:${lastCol(TRACKING_TAB)}${row}`))[0] ?? [];
    const parsed = parseTracking(back, row);
    if (parsed && parsed.contactId === rec.contactId && parsed.claimedAt === rec.claimedAt) return parsed;
    // The expected row was taken by a concurrent append: locate ours by ContactID (unique per tracking row).
    const found = (await this.readTracking()).records.filter((r) => r.contactId === rec.contactId).sort((a, b) => b.row - a.row)[0];
    if (!found) throw new Error("The tracking row could not be read back after writing.");
    return found;
  }

  async updateTracking(rec: TrackingRecord): Promise<void> {
    if (rec.row < 2) throw new Error("updateTracking needs a written row");
    await this.client.updateValues(`${q(TRACKING_TAB)}!A${rec.row}:${lastCol(TRACKING_TAB)}${rec.row}`, [serializeTracking(rec)]);
  }

  async upsertCounters(c: DailyCounters, nowIso: string): Promise<void> {
    const values = [
      c.day, c.importedToday, c.addedToConnections, c.emailsDrafted, c.emailsSent, c.awaitingProcessing, c.requiringReview, c.failedProcessing, c.importFailed, c.queueRemaining, nowIso,
      c.sentToday, c.sentTodayByMember.anni, c.sentTodayByMember.lukky, c.sentTodayByMember.rishii, c.failedSends, c.skippedContacts, c.duplicatesPrevented, c.sendsNeedingReview,
    ].map(String);
    const grid = await this.client.getValues(`${q(COUNTERS_TAB)}!A:A`);
    const at = grid.findIndex((r, i) => i > 0 && (r[0] ?? "").trim() === c.day);
    if (at >= 0) await this.client.updateValues(`${q(COUNTERS_TAB)}!A${at + 1}:${lastCol(COUNTERS_TAB)}${at + 1}`, [values]);
    else await this.client.appendValues(`${q(COUNTERS_TAB)}!A:${lastCol(COUNTERS_TAB)}`, [values]);
  }

  async readSendLedger(): Promise<{ records: SendRecord[]; nextRow: number }> {
    const grid = await this.client.getValues(`${q(SEND_LEDGER_TAB)}!A:${lastCol(SEND_LEDGER_TAB)}`);
    const records: SendRecord[] = [];
    for (let i = 1; i < grid.length; i++) {
      const rec = parseSendRecord(grid[i], i + 1);
      if (rec) records.push(rec);
    }
    return { records, nextRow: Math.max(grid.length, 1) + 1 };
  }

  /** Appends a ledger row and reads it back; it only counts once the read agrees. */
  async appendSendRecord(rec: SendRecord, row: number): Promise<SendRecord> {
    await this.client.appendValues(`${q(SEND_LEDGER_TAB)}!A:${lastCol(SEND_LEDGER_TAB)}`, [serializeSendRecord(rec)]);
    const back = (await this.client.getValues(`${q(SEND_LEDGER_TAB)}!A${row}:${lastCol(SEND_LEDGER_TAB)}${row}`))[0] ?? [];
    const parsed = parseSendRecord(back, row);
    if (parsed && parsed.claimId === rec.claimId) return parsed;
    // Another worker appended between our read and our write, so our row is not where we expected: find it by its unique ClaimID.
    const found = (await this.readSendLedger()).records.find((r) => r.claimId === rec.claimId);
    if (!found) throw new Error("The send-ledger row could not be read back after writing.");
    return found;
  }

  async updateSendRecord(rec: SendRecord): Promise<void> {
    if (rec.row < 2) throw new Error("updateSendRecord needs a written row");
    await this.client.updateValues(`${q(SEND_LEDGER_TAB)}!A${rec.row}:${lastCol(SEND_LEDGER_TAB)}${rec.row}`, [serializeSendRecord(rec)]);
  }

  async readExclusions(): Promise<{ value: string; reason: string }[]> {
    const grid = await this.client.getValues(`${q(EXCLUSIONS_TAB)}!A:D`);
    return grid.slice(1).map((r) => ({ value: (r[0] ?? "").trim().toLowerCase(), reason: (r[1] ?? "").trim() })).filter((e) => e.value);
  }

  /** Small key/value state in the Outreach State tab (e.g. how many sent e-mails have already been announced). */
  async getState(key: string): Promise<string | undefined> {
    const grid = await this.client.getValues(`${q(STATE_TAB)}!A:C`);
    const row = grid.find((r, i) => i > 0 && (r[0] ?? "").trim() === key);
    return row ? (row[1] ?? "").trim() : undefined;
  }

  async setState(key: string, value: string, nowIso: string): Promise<void> {
    const grid = await this.client.getValues(`${q(STATE_TAB)}!A:C`);
    const at = grid.findIndex((r, i) => i > 0 && (r[0] ?? "").trim() === key);
    if (at >= 0) await this.client.updateValues(`${q(STATE_TAB)}!A${at + 1}:C${at + 1}`, [[key, value, nowIso]]);
    else await this.client.appendValues(`${q(STATE_TAB)}!A:C`, [[key, value, nowIso]]);
  }

  /**
   * Claims one notification milestone (e.g. "connections:10") exactly once, across overlapping executions, crashes and retries.
   * Sheets has no transactions, so this uses ordered appends: a claim row is appended to the Outreach State tab, the tab is re-read,
   * and the FIRST row with that key wins; a loser marks its own row "lost" and does not notify. The winner delivers and then calls
   * completeMilestone (the row becomes "done:<id>", the durable record that it was announced). A claim that was never completed because the
   * process died is "stale" after MILESTONE_CLAIM_TTL_MS and may be claimed again; a delivery that failed is released at once.
   */
  async claimMilestone(milestone: string, claimId: string, nowIso: string): Promise<boolean> {
    const key = `milestone:${milestone}`;
    const nowMs = Date.parse(nowIso);
    const cells = (r: string[]) => ({ key: (r[0] ?? "").trim(), value: (r[1] ?? "").trim(), at: Date.parse((r[2] ?? "").trim()) });
    const before = await this.client.getValues(`${q(STATE_TAB)}!A:C`);
    const existing = before.map((r, i) => ({ i, ...cells(r) })).filter((r) => r.i > 0 && r.key === key);
    if (existing.some((r) => r.value.startsWith("done:"))) return false;
    const fresh = existing.filter((r) => !(nowMs - r.at >= MILESTONE_CLAIM_TTL_MS));
    if (fresh.length) return false;
    for (const r of existing) await this.client.updateValues(`${q(STATE_TAB)}!A${r.i + 1}:C${r.i + 1}`, [[`stale:${key}`, r.value, nowIso]]);
    await this.client.appendValues(`${q(STATE_TAB)}!A:C`, [[key, claimId, nowIso]]);
    const after = await this.client.getValues(`${q(STATE_TAB)}!A:C`);
    const rows = after.map((r, i) => ({ i, ...cells(r) })).filter((r) => r.i > 0 && r.key === key);
    if (rows[0]?.value === claimId) return true;
    const mine = rows.find((r) => r.value === claimId);
    if (mine) await this.client.updateValues(`${q(STATE_TAB)}!A${mine.i + 1}:C${mine.i + 1}`, [[`lost:${key}`, claimId, nowIso]]);
    return false;
  }

  /** The winner records that the milestone was delivered. */
  async completeMilestone(milestone: string, claimId: string, nowIso: string): Promise<void> {
    const key = `milestone:${milestone}`;
    const grid = await this.client.getValues(`${q(STATE_TAB)}!A:C`);
    const at = grid.findIndex((r, i) => i > 0 && (r[0] ?? "").trim() === key && (r[1] ?? "").trim() === claimId);
    if (at >= 0) await this.client.updateValues(`${q(STATE_TAB)}!A${at + 1}:C${at + 1}`, [[key, `done:${claimId}`, nowIso]]);
  }

  /** Gives a claim back because the notification could not be delivered, so a later pass may claim and deliver it. */
  async releaseMilestone(milestone: string, claimId: string, nowIso: string): Promise<void> {
    const key = `milestone:${milestone}`;
    const grid = await this.client.getValues(`${q(STATE_TAB)}!A:C`);
    const at = grid.findIndex((r, i) => i > 0 && (r[0] ?? "").trim() === key && (r[1] ?? "").trim() === claimId);
    if (at >= 0) await this.client.updateValues(`${q(STATE_TAB)}!A${at + 1}:C${at + 1}`, [[`released:${key}`, claimId, nowIso]]);
  }

  /** Milestones that are announced ("done") or being announced right now (a fresh claim), e.g. "connections:10". */
  async claimedMilestones(nowIso: string): Promise<Set<string>> {
    const nowMs = Date.parse(nowIso);
    const grid = await this.client.getValues(`${q(STATE_TAB)}!A:C`);
    const out = new Set<string>();
    for (const r of grid.slice(1)) {
      const key = (r[0] ?? "").trim();
      if (!key.startsWith("milestone:")) continue;
      const value = (r[1] ?? "").trim();
      if (value.startsWith("done:") || !(nowMs - Date.parse((r[2] ?? "").trim()) >= MILESTONE_CLAIM_TTL_MS)) out.add(key.slice("milestone:".length));
    }
    return out;
  }

  /** Claim ids this instance holds, per lock key ("run-lock" = one cycle at a time; "bg-runner" = one background runner at a time). */
  private lockIds = new Map<string, string>();

  /**
   * One worker per lock KEY at a time, safe against simultaneous callers. Sheets has no transactions, so this uses ordered appends (like the send
   * ledger): if no live lock exists the caller appends a claim row `<key> | <expiry>:<id>`, re-reads the tab, and the FIRST live claim wins; a
   * loser writes nothing more and stands down. The lock expires by itself after `ttlMs`, so a crashed or killed run never blocks later ones.
   * The winner removes expired claim rows so the tab does not grow. The default key is the per-cycle "run-lock" (behaviour unchanged).
   */
  async acquireLock(now: number, ttlMs: number, key = RUN_LOCK_KEY): Promise<boolean> {
    const parse = (r: string[]) => ({ key: (r[0] ?? "").trim(), expiry: Number(String(r[1] ?? "").split(":")[0]) || 0, id: String(r[1] ?? "").split(":")[1] ?? "" });
    const live = (grid: string[][]) => grid.map((r, i) => ({ i, ...parse(r) })).filter((r) => r.i > 0 && r.key === key && r.expiry > now);
    if (live(await this.client.getValues(`${q(STATE_TAB)}!A:C`)).length) return false;
    const id = randomUUID();
    await this.client.appendValues(`${q(STATE_TAB)}!A:C`, [[key, `${now + ttlMs}:${id}`, new Date(now).toISOString()]]);
    const after = await this.client.getValues(`${q(STATE_TAB)}!A:C`);
    if (live(after)[0]?.id !== id) return false; // an earlier claim won
    this.lockIds.set(key, id);
    // housekeeping (only the holder deletes, so row numbers cannot shift under another caller's claim): expired claims and the legacy single row
    const stale = after.map((r, i) => ({ i, ...parse(r) })).filter((r) => r.i > 0 && r.key === key && r.expiry <= now).map((r) => r.i + 1);
    if (stale.length) await this.client.deleteRows(STATE_TAB, stale).catch(() => undefined);
    return true;
  }

  /**
   * Extends a lock this instance holds (a heartbeat, for long-running holders). Returns false when the claim is gone, has expired, or is no
   * longer the first live claim of its key, i.e. somebody else owns the lock now and the caller must stop. A holder that stops renewing simply
   * lets the lock expire, which is how a killed run frees it.
   */
  async renewLock(now: number, ttlMs: number, key = RUN_LOCK_KEY): Promise<boolean> {
    const id = this.lockIds.get(key);
    if (!id) return false;
    const grid = await this.client.getValues(`${q(STATE_TAB)}!A:C`);
    const rows = grid.map((r, i) => ({ i, k: (r[0] ?? "").trim(), expiry: Number(String(r[1] ?? "").split(":")[0]) || 0, id: String(r[1] ?? "").split(":")[1] ?? "" })).filter((r) => r.i > 0 && r.k === key);
    const mine = rows.find((r) => r.id === id);
    if (!mine || mine.expiry <= now) {
      this.lockIds.delete(key); // expired: another claimant may already hold it, so this instance no longer owns it
      return false;
    }
    if (rows.find((r) => r.expiry > now)?.id !== id) {
      this.lockIds.delete(key);
      return false;
    }
    await this.client.updateValues(`${q(STATE_TAB)}!A${mine.i + 1}:C${mine.i + 1}`, [[key, `${now + ttlMs}:${id}`, new Date(now).toISOString()]]);
    return true;
  }

  async releaseLock(now: number, key = RUN_LOCK_KEY): Promise<void> {
    const id = this.lockIds.get(key);
    if (!id) return;
    const grid = await this.client.getValues(`${q(STATE_TAB)}!A:C`);
    const at = grid.findIndex((r, i) => i > 0 && (r[0] ?? "").trim() === key && String(r[1] ?? "").endsWith(`:${id}`));
    if (at >= 0) await this.client.updateValues(`${q(STATE_TAB)}!A${at + 1}:C${at + 1}`, [[key, `0:${id}`, new Date(now).toISOString()]]);
    this.lockIds.delete(key);
  }
}

/** The per-cycle lock (65 s TTL) and the lock of the single background runner that executes cycles one after another. */
export const RUN_LOCK_KEY = "run-lock";
export const RUNNER_LOCK_KEY = "bg-runner";

export const memberOf = (id: string): id is MemberId => (MEMBER_IDS as readonly string[]).includes(id);

export function serializeSendRecord(r: SendRecord): string[] {
  return [
    r.sendKey, r.contactId, r.claimId, r.status, r.member, r.gmailAccount, r.connectionId, r.company, r.role, r.resumeFile, r.resumeSha256, String(r.resumeBytes),
    r.draftId, r.threadId, r.gmailMessageId, String(r.wordCount), String(r.attempts), r.notBefore, r.sentAt, r.sentDay, r.reason, r.history, r.createdAt, r.updatedAt,
  ];
}

export function parseSendRecord(cells: readonly string[], row: number): SendRecord | null {
  const c = (i: number) => (cells[i] ?? "").toString().trim();
  if (!c(0) || !c(2) || !(LEDGER_STATUSES as readonly string[]).includes(c(3))) return null;
  return {
    row, sendKey: c(0), contactId: c(1), claimId: c(2), status: c(3) as SendLedgerStatus, member: c(4), gmailAccount: c(5), connectionId: c(6), company: c(7), role: c(8), resumeFile: c(9),
    resumeSha256: c(10), resumeBytes: Number(c(11)) || 0, draftId: c(12), threadId: c(13), gmailMessageId: c(14), wordCount: Number(c(15)) || 0, attempts: Number(c(16)) || 0, notBefore: c(17),
    sentAt: c(18), sentDay: c(19), reason: c(20), history: c(21), createdAt: c(22), updatedAt: c(23),
  };
}
