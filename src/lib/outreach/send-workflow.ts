/**
 * The outreach SEND workflow. Behind the compile-time gate: with `gate` false (the shipped state) it does nothing at all.
 *
 * For each eligible contact it runs ALL fourteen validations (see CHECKS) in a cheap-first order and sends ONLY if every one passes.
 * The message sent is the member's own, already-created Gmail draft, read back and verified first. Outcomes:
 *   A  every check passes            -> claim (durable), mark "sending", drafts.send, confirm, THEN record "sent" and count it
 *   B  resume unavailable            -> not sent; the (attachment-less, review-flagged) draft stays for the member; sendStatus "review"
 *   C  personalisation/validation    -> not sent; exact reason recorded; the draft stays; sendStatus "review"
 *   D  Gmail auth / quota / API fail -> nothing counted; error + retry time recorded; no duplicate message or draft
 *   E  uncertain result              -> never retried blindly; reconciled against Gmail; unprovable => manual review
 * Counters are derived from the confirmed rows this module writes.
 */
import { createHash } from "node:crypto";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import type { DraftReadback, Reconciliation, ReadResult, SendOutcome } from "@/lib/gmail/send";
import type { ResumeLookup } from "@/lib/gmail/attachment";
import { normalizeEmail } from "@/lib/hr-master/normalize";
import { dateInTimezone } from "@/lib/utils/time";
import type { Connection } from "@/types/domain";
import { importEligibility, firstInDuplicateGroups, parseMasterRows } from "./contacts";
import { checkAttachment, checkDraft } from "./draft-check";
import { isExcluded, matchesAllowlist } from "./exclusions";
import { limitReason, usageToday, type SendLimits } from "./limits";
import { MAX_SEND_ATTEMPTS, claimSend, normalKey, releaseStaleClaims, rowsFor, withHistory } from "./send-ledger";
import type { OutreachSheet } from "./sheet";
import { draftKeyFor } from "./sync";
import type { SendRecord, TrackingRecord } from "./types";

/** The fourteen pre-send validations, in the order they are reported (evaluation order is cheap-first, see `evaluate`). */
export const CHECKS = [
  "valid_email", "eligible", "connection", "owner", "member_identity", "email_generated", "content_supported", "word_limit",
  "not_already_received", "not_excluded", "no_prior_send", "resume", "gmail_auth", "daily_limit",
] as const;
export type CheckId = (typeof CHECKS)[number];

export interface GmailPort {
  /** The member's connected Gmail address, or null when not connected. */
  address(member: MemberId): Promise<string | null>;
  readDraft(member: MemberId, draftId: string): Promise<ReadResult>;
  send(member: MemberId, draftId: string): Promise<SendOutcome | { status: "no_access"; access: string }>;
  reconcile(member: MemberId, draftId: string, threadId: string | undefined): Promise<Reconciliation>;
}

export interface DraftInfo {
  status: string;
  detail: string;
  gmailDraftId: string;
  threadId?: string;
}

export interface SendDeps {
  /** The compile-time SENDING_ENABLED, passed in by the cycle. Tests pass true with MOCK ports only. */
  gate: boolean;
  sheet: Pick<OutreachSheet, "readTracking" | "updateTracking" | "readSendLedger" | "appendSendRecord" | "updateSendRecord" | "readExclusions" | "readMaster">;
  gmail: GmailPort;
  resumes: ResumeLookup;
  connections: { listFresh(): Promise<Connection[]>; markMessaged(c: Connection): Promise<void> };
  drafts: { snapshot(): Promise<ReadonlyMap<string, DraftInfo>>; markSent(member: MemberId, connectionId: string): Promise<void> };
  limits: SendLimits;
  now: () => Date;
  timezone: string;
  deadline?: number;
  /** When non-empty, ONLY these recipients may ever be sent to (see config OUTREACH_SEND_ONLY_TO). */
  allowlist?: readonly string[];
}

export interface SendRunResult {
  status: "disabled" | "ran";
  sent: number;
  blocked: number;
  needsReview: number;
  failed: number;
  waiting: number;
  duplicatesPrevented: number;
  reconciled: number;
  stoppedBecause: "none" | "per-run-limit" | "rate-limited" | "deadline" | "error";
  errors: string[];
}

const zero = (status: SendRunResult["status"]): SendRunResult => ({ status, sent: 0, blocked: 0, needsReview: 0, failed: 0, waiting: 0, duplicatesPrevented: 0, reconciled: 0, stoppedBecause: "none", errors: [] });

type Evaluation =
  | { kind: "send"; ctx: SendContext }
  | { kind: "wait"; check: CheckId; reason: string }
  | { kind: "block"; check: CheckId; reason: string }
  | { kind: "review"; check: CheckId; reason: string }
  | { kind: "auth"; check: CheckId; reason: string };

interface SendContext {
  member: MemberId;
  connection: Connection;
  draft: DraftInfo;
  readback: DraftReadback;
  address: string;
  role: string;
  resume: { fileName: string; bytes: number; sha256: string };
  words: number;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Runs the validations for one tracked contact. Cheap, local checks first; Gmail is read only after everything else passed. */
async function evaluate(deps: SendDeps, rec: TrackingRecord, env: { connections: Map<string, Connection>; drafts: ReadonlyMap<string, DraftInfo>; ledger: readonly SendRecord[]; tracking: readonly TrackingRecord[]; exclusions: { value: string; reason: string }[]; eligibleIds: ReadonlySet<string> | null; day: string }): Promise<Evaluation> {
  const email = normalizeEmail(rec.email);
  if (!email.valid) return { kind: "block", check: "valid_email", reason: `invalid recipient address (${email.reason})` };
  const key = normalKey(email.email);

  if (!matchesAllowlist(email.email, deps.allowlist ?? [])) return { kind: "block", check: "not_excluded", reason: "recipient is not on the send allowlist (controlled-test safeguard)" };
  const excluded = isExcluded(email.email, env.exclusions);
  if (excluded) return { kind: "block", check: "not_excluded", reason: `opted out / excluded (${excluded})` };

  if (rec.source === "outreach-database" && env.eligibleIds && !env.eligibleIds.has(rec.contactId)) return { kind: "block", check: "eligible", reason: "contact is not eligible for outreach (or is no longer in the Outreach Database)" };
  if (rec.importStatus !== "added" || !rec.connectionId) return { kind: "block", check: "connection", reason: "no Connection has been created for this contact" };

  const conn = env.connections.get(rec.connectionId);
  if (!conn) return { kind: "block", check: "connection", reason: "the Connection no longer exists" };
  if (conn.status !== "Not Connected") return { kind: "block", check: "not_already_received", reason: `the Connection is already "${conn.status}"` };

  const member = conn.memberId;
  if (!(MEMBER_IDS as readonly string[]).includes(member) || rec.ownerMemberId !== member) return { kind: "block", check: "owner", reason: "the Connection's owner does not match the tracked owner" };

  // Duplicate protection: this recipient, anywhere, by anyone.
  const priorLedger = rowsFor(env.ledger, key).find((r) => r.status === "sent" || r.status === "sending" || r.status === "uncertain" || (r.status === "claimed"));
  if (rec.sendStatus === "sent" || priorLedger?.status === "sent") return { kind: "block", check: "no_prior_send", reason: "a message to this recipient was already sent successfully" };
  if (priorLedger) return { kind: "block", check: "no_prior_send", reason: `another send to this recipient is ${priorLedger.status}` };
  if (rowsFor(env.ledger, key).some((r) => r.status === "needs_review" || r.status === "failed_permanent")) return { kind: "review", check: "no_prior_send", reason: "an earlier send attempt needs manual review" };
  for (const m of MEMBER_IDS) {
    const d = env.drafts.get(draftKeyFor(rec.connectionId, m));
    if (d?.status === "sent") return { kind: "block", check: "not_already_received", reason: `${m} already sent a message to this recipient from their own Gmail` };
  }
  if (env.tracking.some((t) => t !== rec && normalKey(t.email) === key && t.sendStatus === "sent")) return { kind: "block", check: "not_already_received", reason: "this recipient already received outreach through another record" };

  const address = await deps.gmail.address(member);
  if (!address) return { kind: "auth", check: "member_identity", reason: `${member}'s Gmail is not connected` };

  const draft = env.drafts.get(draftKeyFor(rec.connectionId, member));
  if (!draft || draft.status === "skipped_unauthorized") return { kind: "wait", check: "email_generated", reason: "waiting for the personalised draft in the owner's mailbox" };
  if (draft.status !== "created") return { kind: "block", check: "email_generated", reason: `the owner's draft is "${draft.status}"` };
  if (!draft.gmailDraftId) return { kind: "wait", check: "email_generated", reason: "the owner's draft has no Gmail id yet" };
  const flagged = draft.detail.split("; ").filter((p) => p.startsWith("review:")).map((p) => p.slice(7).trim());
  if (flagged.length) return { kind: "review", check: /resume|attachment/i.test(flagged.join(" ")) ? "resume" : "content_supported", reason: flagged.join(" | ") };

  // A transient failure is retried only after its back-off, and only a limited number of times.
  const mine = rowsFor(env.ledger, key);
  const backoff = mine.filter((r) => r.status === "failed_transient" && r.notBefore && Date.parse(r.notBefore) > deps.now().getTime()).sort((a, b) => b.notBefore.localeCompare(a.notBefore))[0];
  if (backoff) return { kind: "wait", check: "gmail_auth", reason: `retry scheduled after ${backoff.notBefore} (${backoff.reason})` };
  if (mine.filter((r) => r.status === "failed_transient").length >= MAX_SEND_ATTEMPTS) return { kind: "review", check: "gmail_auth", reason: `${MAX_SEND_ATTEMPTS} send attempts failed; manual review needed` };

  const usage = usageToday(env.ledger as SendRecord[], env.day, deps.now().getTime());
  const limited = limitReason(deps.limits, usage, member, 0);
  if (limited) return { kind: "wait", check: "daily_limit", reason: limited };

  // Gmail is read only now. The REAL saved draft is what gets verified.
  const read = await deps.gmail.readDraft(member, draft.gmailDraftId);
  if (read.status === "no_access") return { kind: "auth", check: "gmail_auth", reason: `Gmail authorisation for ${member} is not valid (${read.access})` };
  if (read.status === "not_found") return { kind: "block", check: "email_generated", reason: "the draft no longer exists in Gmail (deleted or already sent)" };
  if (read.status === "error") return { kind: "wait", check: "gmail_auth", reason: `Gmail could not be read (${read.reason})` };

  const role = (conn.applyRole || rec.targetRole || "").trim();
  const check = checkDraft(read.draft, { member, recipientEmail: email.email, personName: conn.name, companyName: conn.company ?? "", applyRole: role });
  if (!check.ok) {
    const f = check.failures[0];
    return { kind: "review", check: f.check === "word_limit" ? "word_limit" : f.check === "recipient" ? "valid_email" : "content_supported", reason: check.failures.map((x) => x.reason).join(" | ") };
  }

  const found = await deps.resumes(member, role).catch((): import("@/lib/gmail/attachment").ResumeResult => ({ status: "unreadable", reason: "lookup failed" }));
  if (found.status !== "attached") {
    const why = found.status === "unmapped" ? (found.reason ?? "no resume is mapped") : found.status === "missing" ? `${found.fileName} is missing` : found.status === "unreadable" ? found.reason : "resumes are not enabled";
    return { kind: "review", check: "resume", reason: `resume unavailable: ${why}` };
  }
  const attachProblem = checkAttachment(read.draft, { fileName: found.attachment.fileName, bytes: found.attachment.bytes.length });
  if (attachProblem) return { kind: "review", check: "resume", reason: attachProblem };

  return { kind: "send", ctx: { member, connection: conn, draft, readback: read.draft, address, role, resume: { fileName: found.attachment.fileName, bytes: found.attachment.bytes.length, sha256: sha256(found.attachment.bytes) }, words: check.words } };
}

const patchTracking = async (deps: SendDeps, rec: TrackingRecord, patch: Partial<TrackingRecord>) => {
  const next = { ...rec, ...patch, updatedAt: deps.now().toISOString() };
  await deps.sheet.updateTracking(next);
  Object.assign(rec, next);
};
const patchLedger = async (deps: SendDeps, rec: SendRecord, patch: Partial<SendRecord>, event: string) => {
  const stamp = deps.now().toISOString();
  const next = { ...rec, ...patch, history: withHistory(rec.history, stamp, event), updatedAt: stamp };
  await deps.sheet.updateSendRecord(next);
  Object.assign(rec, next);
};

/** Records a confirmed send. The ledger row is the source of truth; the other updates are best-effort and noted if they fail. */
async function finishSent(deps: SendDeps, ledger: SendRecord, tracking: TrackingRecord | undefined, conn: Connection | undefined, messageId: string, threadId: string | undefined, via: string) {
  const day = dateInTimezone(deps.now(), deps.timezone);
  await patchLedger(deps, ledger, { status: "sent", gmailMessageId: messageId, ...(threadId ? { threadId } : {}), sentAt: deps.now().toISOString(), sentDay: day, reason: "" }, `sent (${via}); message ${messageId}`);
  const notes: string[] = [];
  if (tracking) await patchTracking(deps, tracking, { sendStatus: "sent", sentAt: ledger.sentAt, sentBy: ledger.member, gmailAccount: ledger.gmailAccount, gmailMessageId: messageId, resumeSent: ledger.resumeFile, sendAttempts: ledger.attempts, sendBlockReason: "", lastError: "" }).catch(() => notes.push("tracking update failed"));
  await deps.drafts.markSent(ledger.member as MemberId, ledger.connectionId).catch(() => notes.push("draft ledger update failed"));
  if (conn) await deps.connections.markMessaged(conn).catch(() => notes.push("connection status update failed"));
  if (notes.length) await patchLedger(deps, ledger, {}, `follow-ups incomplete: ${notes.join(", ")}`).catch(() => undefined);
}

const RETRY_AFTER_TRANSIENT_MS = 10 * 60_000;
const RETRY_AFTER_AUTH_MS = 60 * 60_000;
const RETRY_AFTER_RATE_MS = 15 * 60_000;
/** A send that was started but has no recorded result is only reconciled once it is this old (Gmail may still be finishing it). */
const RECONCILE_AFTER_MS = 2 * 60_000;

/** Interrupted / uncertain sends are reconciled against Gmail BEFORE anything else is sent. Never retries a send. */
async function reconcileInFlight(deps: SendDeps, result: SendRunResult, trackingAll: TrackingRecord[], conns: Map<string, Connection>) {
  const { records } = await deps.sheet.readSendLedger();
  const nowMs = deps.now().getTime();
  for (const r of records) {
    if (r.status !== "sending" && r.status !== "uncertain") continue;
    if (nowMs - Date.parse(r.updatedAt || r.createdAt) < RECONCILE_AFTER_MS) continue;
    if (result.reconciled >= 5) break;
    const rec = trackingAll.find((t) => t.contactId === r.contactId);
    const verdict = await deps.gmail.reconcile(r.member as MemberId, r.draftId, r.threadId || undefined).catch((): Reconciliation => ({ state: "unknown", reason: "reconcile failed" }));
    result.reconciled += 1;
    if (verdict.state === "sent") {
      await finishSent(deps, r, rec, conns.get(r.connectionId), verdict.messageId ?? "", r.threadId || undefined, "confirmed by reconciliation");
    } else if (verdict.state === "not_sent") {
      await patchLedger(deps, r, { status: "failed_transient", notBefore: new Date(nowMs + RETRY_AFTER_TRANSIENT_MS).toISOString(), reason: "Gmail shows the send did not happen" }, "reconciled: not sent, safe to retry later");
      if (rec) await patchTracking(deps, rec, { sendStatus: "failed", sendBlockReason: "the send did not go through; it will be retried", sendAttempts: r.attempts });
    } else {
      if (r.status !== "uncertain" || r.reason !== verdict.reason) await patchLedger(deps, r, { status: "uncertain", reason: verdict.reason }, `reconciled: unknown (${verdict.reason})`);
      if (rec && rec.sendStatus !== "uncertain") await patchTracking(deps, rec, { sendStatus: "uncertain", sendBlockReason: `send result could not be confirmed: ${verdict.reason}`, sendAttempts: r.attempts });
    }
  }
}

export async function runSendStep(deps: SendDeps): Promise<SendRunResult> {
  if (!deps.gate) return zero("disabled"); // defence in depth: refuses before reading or writing anything
  const result = zero("ran");
  const now = deps.now();
  const day = dateInTimezone(now, deps.timezone);

  await releaseStaleClaims(deps.sheet, now);
  const tracking = (await deps.sheet.readTracking()).records;
  const conns = new Map((await deps.connections.listFresh()).map((c) => [c.connectionId, c]));
  await reconcileInFlight(deps, result, tracking, conns);

  const parsed = parseMasterRows(await deps.sheet.readMaster());
  const first = firstInDuplicateGroups(parsed.contacts);
  const eligibleIds = new Set(parsed.contacts.filter((c) => importEligibility(c, first).eligible).map((c) => c.contactId));
  const exclusions = await deps.sheet.readExclusions();
  const drafts = await deps.drafts.snapshot();

  // Oldest first; contacts already past the send workflow (sent) or waiting on a person (uncertain) are not candidates.
  const candidates = tracking
    .filter((t) => t.importStatus === "added" && t.connectionId && t.sendStatus !== "sent" && t.sendStatus !== "uncertain")
    .sort((a, b) => (a.addedAt || a.claimedAt).localeCompare(b.addedAt || b.claimedAt));

  for (const rec of candidates) {
    if (result.sent >= deps.limits.perRun) { result.stoppedBecause = "per-run-limit"; break; }
    if (deps.deadline !== undefined && Date.now() > deps.deadline) { result.stoppedBecause = "deadline"; break; }
    try {
      const ledger = (await deps.sheet.readSendLedger()).records;
      const ev = await evaluate(deps, rec, { connections: conns, drafts, ledger, tracking, exclusions, eligibleIds: parsed.contacts.length ? eligibleIds : null, day });
      if (ev.kind !== "send") {
        const status = ev.kind === "review" ? "review" : ev.kind === "wait" ? "pending" : "blocked";
        const reason = `[${ev.check}] ${ev.reason}`.slice(0, 480);
        if (rec.sendStatus !== status || rec.sendBlockReason !== reason) await patchTracking(deps, rec, { sendStatus: status, sendBlockReason: reason });
        if (ev.kind === "review") result.needsReview += 1;
        else if (ev.kind === "wait" || ev.kind === "auth") result.waiting += 1;
        else result.blocked += 1;
        if (ev.check === "no_prior_send" || ev.check === "not_already_received") result.duplicatesPrevented += 1;
        continue;
      }
      const ctx = ev.ctx;
      const key = normalKey(rec.email);
      const claim = await claimSend(deps.sheet, {
        sendKey: key, contactId: rec.contactId, member: ctx.member, gmailAccount: ctx.address, connectionId: rec.connectionId, company: ctx.connection.company ?? "", role: ctx.role,
        draftId: ctx.draft.gmailDraftId, threadId: ctx.readback.threadId ?? ctx.draft.threadId ?? "", resumeFile: ctx.resume.fileName, resumeSha256: ctx.resume.sha256, resumeBytes: ctx.resume.bytes, wordCount: ctx.words,
      }, day, now);
      if (!claim.won) {
        result.duplicatesPrevented += 1;
        await patchTracking(deps, rec, { sendStatus: claim.reason === "already_sent" ? "sent" : claim.reason === "needs_review" || claim.reason === "failed_permanent" || claim.reason === "too_many_attempts" ? "review" : "blocked", sendBlockReason: `[no_prior_send] ${claim.reason.replace(/_/g, " ")}` });
        continue;
      }
      let row = claim.record;
      // Persist "sending" BEFORE the Gmail call: a crash after this point is reconciled, never blindly retried.
      await patchLedger(deps, row, { status: "sending", draftId: ctx.draft.gmailDraftId }, "sending");
      await patchTracking(deps, rec, { sendStatus: "claimed", sendBlockReason: "", sendAttempts: row.attempts });
      const out = await deps.gmail.send(ctx.member, ctx.draft.gmailDraftId);

      if (out.status === "sent") {
        await finishSent(deps, row, rec, ctx.connection, out.messageId, out.threadId, "confirmed by Gmail");
        result.sent += 1;
      } else if (out.status === "rate_limited") {
        const wait = Math.max(out.retryAfterMs ?? 0, RETRY_AFTER_RATE_MS);
        await patchLedger(deps, row, { status: "failed_transient", notBefore: new Date(now.getTime() + wait).toISOString(), reason: "Gmail rate limit / quota" }, "rate limited; nothing was sent");
        await patchTracking(deps, rec, { sendStatus: "failed", sendBlockReason: "[gmail_auth] Gmail rate limit reached; will retry later", lastError: "rate_limited" });
        result.failed += 1;
        result.stoppedBecause = "rate-limited";
        break;
      } else if (out.status === "auth_failed" || out.status === "no_access") {
        const reason = out.status === "auth_failed" ? out.reason : `no Gmail access (${out.access})`;
        await patchLedger(deps, row, { status: "failed_transient", notBefore: new Date(now.getTime() + RETRY_AFTER_AUTH_MS).toISOString(), reason }, `authorisation failure; nothing was sent`);
        await patchTracking(deps, rec, { sendStatus: "failed", sendBlockReason: `[gmail_auth] ${reason}`, lastError: "auth" });
        result.failed += 1;
      } else if (out.status === "rejected") {
        await patchLedger(deps, row, { status: "failed_permanent", reason: out.reason }, "rejected by Gmail; will not be retried");
        await patchTracking(deps, rec, { sendStatus: "review", sendBlockReason: `[valid_email] Gmail rejected the message: ${out.reason}`, lastError: "rejected" });
        result.needsReview += 1;
      } else {
        // uncertain (timeout, 5xx, unconfirmed 2xx, or "draft missing" which may mean it was already sent): reconcile NOW, never resend.
        row = (await deps.sheet.readSendLedger()).records.find((r) => r.claimId === row.claimId) ?? row;
        await patchLedger(deps, row, { status: "uncertain", reason: out.status === "uncertain" ? out.reason : "draft not found after the send request" }, "uncertain send result; reconciling");
        const verdict = await deps.gmail.reconcile(ctx.member, ctx.draft.gmailDraftId, row.threadId || undefined).catch((): Reconciliation => ({ state: "unknown", reason: "reconcile failed" }));
        result.reconciled += 1;
        if (verdict.state === "sent") {
          await finishSent(deps, row, rec, ctx.connection, verdict.messageId ?? "", row.threadId || undefined, "confirmed by reconciliation");
          result.sent += 1;
        } else if (verdict.state === "not_sent") {
          await patchLedger(deps, row, { status: "failed_transient", notBefore: new Date(now.getTime() + RETRY_AFTER_TRANSIENT_MS).toISOString(), reason: "Gmail shows the send did not happen" }, "reconciled: not sent, safe to retry later");
          await patchTracking(deps, rec, { sendStatus: "failed", sendBlockReason: "[gmail_auth] the send did not go through; it will be retried", lastError: "transient" });
          result.failed += 1;
        } else {
          await patchLedger(deps, row, { status: "uncertain", reason: verdict.reason }, `reconciled: unknown (${verdict.reason})`);
          await patchTracking(deps, rec, { sendStatus: "uncertain", sendBlockReason: `send result could not be confirmed: ${verdict.reason}`, lastError: "uncertain" });
          result.needsReview += 1;
        }
      }
    } catch (err) {
      // An unexpected exception can never turn into a send: nothing here sends after a throw; the next call re-evaluates from the ledger.
      result.errors.push(err instanceof Error ? err.name : "error");
      result.stoppedBecause = "error";
      break;
    }
  }
  return result;
}

