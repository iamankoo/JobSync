/**
 * Durable idempotency for sending, built on what Google Sheets really offers: ordered appends, no transactions.
 *
 * Protocol (per recipient e-mail, the SendKey):
 *  1. Look at the ledger. If any row for the key is already ACTIVE (claimed, sending, sent, uncertain) or BLOCKING
 *     (needs_review, failed_permanent), do not send: the earlier attempt owns the key.
 *  2. Append a new `claimed` row with a unique ClaimID (and read it back).
 *  3. Re-read the ledger. Among the rows for the key that are ACTIVE, the FIRST row (lowest row number) wins. Appends are totally
 *     ordered by Sheets, so every concurrent worker sees the same winner. A loser marks its own row `superseded` and does not send.
 *  4. The winner records `sending` (with the draft id) BEFORE calling Gmail, and the final status after. A crash between 4 and
 *     the final status leaves `sending`, which is reconciled against Gmail, never retried blindly.
 */
import { randomUUID } from "node:crypto";
import { CLAIM_TTL_MS } from "./limits";
import type { OutreachSheet } from "./sheet";
import type { SendLedgerStatus, SendRecord } from "./types";

/** A send for this key may be in flight or has happened: no other attempt may start. */
export const ACTIVE: readonly SendLedgerStatus[] = ["claimed", "sending", "sent", "uncertain"];
/** Needs a person (or a deliberate reset) before anything is sent to this key again. */
export const BLOCKING: readonly SendLedgerStatus[] = ["needs_review", "failed_permanent"];
export const MAX_SEND_ATTEMPTS = 3;
const HISTORY_MAX = 900;

export const normalKey = (email: string) => email.trim().toLowerCase();

/**
 * The idempotency key of ONE send: the sending member AND the normalised recipient. The same recipient legitimately receives one
 * separately personalised e-mail from each member (the shared-Connection workflow), but never two from the same member's account.
 */
export const sendKeyFor = (member: string, email: string) => `${member}|${normalKey(email)}`;
/** The recipient part of a send key (also accepts the older recipient-only keys). */
export const recipientOfKey = (key: string) => (key.includes("|") ? key.slice(key.indexOf("|") + 1) : key);

export const rowsFor = (records: readonly SendRecord[], key: string) => records.filter((r) => r.sendKey === key);

/** Appends "<iso> <event>" to the history, keeping the newest ~900 characters. */
export function withHistory(history: string, at: string, event: string): string {
  const next = `${history ? history + "; " : ""}${at} ${event}`;
  return next.length > HISTORY_MAX ? "…" + next.slice(next.length - HISTORY_MAX) : next;
}

export type ClaimResult =
  /** `ledger`: the ledger as read right AFTER this claim was appended (the caller can use it instead of reading the tab again). */
  | { won: true; record: SendRecord; ledger: SendRecord[] }
  | { won: false; reason: "already_sent" | "in_flight" | "needs_review" | "failed_permanent" | "lost_race" | "too_many_attempts" | "limit_reached"; existing?: SendRecord };

export type ClaimInput = Pick<SendRecord, "sendKey" | "contactId" | "member" | "gmailAccount" | "connectionId" | "company" | "role" | "draftId" | "threadId" | "resumeFile" | "resumeSha256" | "resumeBytes" | "wordCount">;

type LedgerSheet = Pick<OutreachSheet, "readSendLedger" | "appendSendRecord" | "updateSendRecord">;

/** Evaluated against the ledger AFTER this claim was appended; a non-null result releases the claim (e.g. a concurrent worker used the last slot). */
export type PostClaimCheck = (ledger: readonly SendRecord[], mine: SendRecord) => string | null;

export async function claimSend(sheet: LedgerSheet, input: ClaimInput, day: string, now: Date, postCheck?: PostClaimCheck): Promise<ClaimResult> {
  const stamp = now.toISOString();
  const before = await sheet.readSendLedger();
  const mine = rowsFor(before.records, input.sendKey);
  const sent = mine.find((r) => r.status === "sent");
  if (sent) return { won: false, reason: "already_sent", existing: sent };
  const live = mine.find((r) => ACTIVE.includes(r.status) && !(r.status === "claimed" && now.getTime() - Date.parse(r.updatedAt || r.createdAt) >= CLAIM_TTL_MS));
  if (live) return { won: false, reason: "in_flight", existing: live };
  const blocking = mine.find((r) => BLOCKING.includes(r.status));
  if (blocking) return { won: false, reason: blocking.status === "needs_review" ? "needs_review" : "failed_permanent", existing: blocking };
  const failures = mine.filter((r) => r.status === "failed_transient").length;
  if (failures >= MAX_SEND_ATTEMPTS) return { won: false, reason: "too_many_attempts" };

  const claimId = randomUUID();
  const record: SendRecord = {
    ...input, row: 0, claimId, status: "claimed", attempts: failures + 1, notBefore: "", sentAt: "", sentDay: day, gmailMessageId: "", reason: "",
    history: withHistory("", stamp, `claimed (attempt ${failures + 1})`), createdAt: stamp, updatedAt: stamp,
  };
  await sheet.appendSendRecord(record, before.nextRow);

  // Who is first among the live rows for this key? Everyone reading after the appends agrees.
  const after = await sheet.readSendLedger();
  const contenders = rowsFor(after.records, input.sendKey).filter((r) => ACTIVE.includes(r.status) && !(r.status === "claimed" && r.claimId !== claimId && now.getTime() - Date.parse(r.updatedAt || r.createdAt) >= CLAIM_TTL_MS));
  const winner = [...contenders].sort((a, b) => a.row - b.row)[0];
  const me = after.records.find((r) => r.claimId === claimId);
  if (!me) throw new Error("claim row disappeared");
  if (!winner || winner.claimId !== claimId) {
    await sheet.updateSendRecord({ ...me, status: "superseded", reason: `lost the claim to row ${winner?.row ?? "?"}`, history: withHistory(me.history, now.toISOString(), "superseded"), updatedAt: now.toISOString() });
    return { won: false, reason: "lost_race", ...(winner ? { existing: winner } : {}) };
  }
  const over = postCheck?.(after.records, me) ?? null;
  if (over) {
    await sheet.updateSendRecord({ ...me, status: "released", reason: over, history: withHistory(me.history, now.toISOString(), `released (${over})`), updatedAt: now.toISOString() });
    return { won: false, reason: "limit_reached" };
  }
  return { won: true, record: me, ledger: after.records };
}

/** Claims that never reached "sending" (a crash before the Gmail call) are released: no request was made, so a new claim is safe. */
export async function releaseStaleClaims(sheet: LedgerSheet, now: Date): Promise<number> {
  const { records } = await sheet.readSendLedger();
  let n = 0;
  for (const r of records) {
    if (r.status === "claimed" && now.getTime() - Date.parse(r.updatedAt || r.createdAt) >= CLAIM_TTL_MS) {
      await sheet.updateSendRecord({ ...r, status: "released", reason: "claim expired before any send was attempted", history: withHistory(r.history, now.toISOString(), "released (stale claim)"), updatedAt: now.toISOString() });
      n += 1;
    }
  }
  return n;
}
