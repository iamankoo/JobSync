/**
 * The outreach SEND workflow. Behind the compile-time gate: with `gate` false (the shipped state) it does nothing at all.
 *
 * For each eligible contact it runs ALL fourteen validations (see CHECKS) in a cheap-first order and sends ONLY if every one passes.
 * One shared Connection produces ONE separately personalised e-mail per member: each member sends their OWN verified Gmail draft from their
 * OWN account (with their own resume). The idempotency unit is (member, recipient): another member's e-mail never blocks yours, but the
 * same account never e-mails the same recipient twice. Outcomes:
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
import { countsAgainstLimit, limitReason, usageRolling, type SendLimits } from "./limits";
import { MAX_SEND_ATTEMPTS, claimSend, normalKey, releaseStaleClaims, rowsFor, sendKeyFor, withHistory } from "./send-ledger";
import type { OutreachSheet } from "./sheet";
import { draftKeyFor } from "./sync";
import type { SendRecord, SendStatus, TrackingRecord } from "./types";

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
  | { kind: "done"; check: CheckId; reason: string }
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
interface Env { connections: Map<string, Connection>; drafts: ReadonlyMap<string, DraftInfo>; ledger: readonly SendRecord[]; tracking: readonly TrackingRecord[]; exclusions: { value: string; reason: string }[]; eligibleIds: ReadonlySet<string> | null; addresses: ReadonlyMap<MemberId, string | null> }

async function evaluate(deps: SendDeps, rec: TrackingRecord, member: MemberId, env: Env): Promise<Evaluation> {
  const email = normalizeEmail(rec.email);
  if (!email.valid) return { kind: "block", check: "valid_email", reason: `invalid recipient address (${email.reason})` };
  const key = sendKeyFor(member, email.email);

  if (!matchesAllowlist(email.email, deps.allowlist ?? [])) return { kind: "block", check: "not_excluded", reason: "recipient is not on the send allowlist (controlled-test safeguard)" };
  const excluded = isExcluded(email.email, env.exclusions);
  if (excluded) return { kind: "block", check: "not_excluded", reason: `opted out / excluded (${excluded})` };

  if (rec.source === "outreach-database" && env.eligibleIds && !env.eligibleIds.has(rec.contactId)) return { kind: "block", check: "eligible", reason: "contact is not eligible for outreach (or is no longer in the Outreach Database)" };
  if (rec.importStatus !== "added" || !rec.connectionId) return { kind: "block", check: "connection", reason: "no Connection has been created for this contact" };

  const conn = env.connections.get(rec.connectionId);
  if (!conn) return { kind: "block", check: "connection", reason: "the Connection no longer exists" };
  if (conn.status !== "Not Connected" && conn.status !== "Messaged") return { kind: "block", check: "not_already_received", reason: `the Connection is already "${conn.status}"` };

  if (!(MEMBER_IDS as readonly string[]).includes(member)) return { kind: "block", check: "owner", reason: "unknown sending member" };

  // Duplicate protection: this recipient, from THIS member's account. (Other members' e-mails to the same recipient are intended.)
  const priorLedger = rowsFor(env.ledger, key).find((r) => r.status === "sent" || r.status === "sending" || r.status === "uncertain" || (r.status === "claimed"));
  if (rec.sendStatus === "sent" || priorLedger?.status === "sent") return { kind: "done", check: "no_prior_send", reason: `${member}'s message to this recipient was already sent successfully` };
  if (priorLedger) return { kind: "block", check: "no_prior_send", reason: `another send to this recipient is ${priorLedger.status}` };
  if (rowsFor(env.ledger, key).some((r) => r.status === "needs_review" || r.status === "failed_permanent")) return { kind: "review", check: "no_prior_send", reason: "an earlier send attempt needs manual review" };
  if (env.drafts.get(draftKeyFor(rec.connectionId, member))?.status === "sent") return { kind: "done", check: "not_already_received", reason: `${member} already sent this message from their own Gmail` };
  const emailKey = normalKey(email.email);
  if (env.tracking.some((t) => t !== rec && normalKey(t.email) === emailKey && t.sendStatus === "sent")) return { kind: "done", check: "not_already_received", reason: "this recipient already received outreach through another record" };

  const address = env.addresses.get(member) ?? null;
  if (!address) return { kind: "auth", check: "member_identity", reason: `${member}'s Gmail is not connected` };

  const draft = env.drafts.get(draftKeyFor(rec.connectionId, member));
  if (!draft || draft.status === "skipped_unauthorized") return { kind: "wait", check: "email_generated", reason: "waiting for the personalised draft in the member's mailbox" };
  if (draft.status !== "created") return { kind: "block", check: "email_generated", reason: `the member's draft is "${draft.status}"` };
  if (!draft.gmailDraftId) return { kind: "wait", check: "email_generated", reason: "the member's draft has no Gmail id yet" };
  const flagged = draft.detail.split("; ").filter((p) => p.startsWith("review:")).map((p) => p.slice(7).trim());
  if (flagged.length) return { kind: "review", check: /resume|attachment/i.test(flagged.join(" ")) ? "resume" : "content_supported", reason: flagged.join(" | ") };

  // A transient failure is retried only after its back-off, and only a limited number of times.
  const mine = rowsFor(env.ledger, key);
  const backoff = mine.filter((r) => r.status === "failed_transient" && r.notBefore && Date.parse(r.notBefore) > deps.now().getTime()).sort((a, b) => b.notBefore.localeCompare(a.notBefore))[0];
  if (backoff) return { kind: "wait", check: "gmail_auth", reason: `retry scheduled after ${backoff.notBefore} (${backoff.reason})` };
  if (mine.filter((r) => r.status === "failed_transient").length >= MAX_SEND_ATTEMPTS) return { kind: "review", check: "gmail_auth", reason: `${MAX_SEND_ATTEMPTS} send attempts failed; manual review needed` };

  const usage = usageRolling(env.ledger, deps.now().getTime());
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
async function finishSent(deps: SendDeps, ledger: SendRecord, messageId: string, threadId: string | undefined, via: string) {
  const day = dateInTimezone(deps.now(), deps.timezone);
  await patchLedger(deps, ledger, { status: "sent", gmailMessageId: messageId, ...(threadId ? { threadId } : {}), sentAt: deps.now().toISOString(), sentDay: day, reason: "" }, `sent (${via}); message ${messageId}`);
  const notes: string[] = [];
  await deps.drafts.markSent(ledger.member as MemberId, ledger.connectionId).catch(() => notes.push("draft ledger update failed"));
  if (notes.length) await patchLedger(deps, ledger, {}, `follow-ups incomplete: ${notes.join(", ")}`).catch(() => undefined);
}

/** The confirmed send (if any) of each member for this contact. */
function sentRowsFor(ledger: readonly SendRecord[], rec: TrackingRecord): Map<MemberId, SendRecord> {
  const out = new Map<MemberId, SendRecord>();
  const email = normalKey(rec.email);
  for (const m of MEMBER_IDS) {
    const row = rowsFor(ledger, sendKeyFor(m, email)).find((r) => r.status === "sent" && r.gmailMessageId.trim() !== "");
    if (row) out.set(m, row);
  }
  return out;
}

/** The aggregate (one tracking row per contact) over the per-member ledger rows. "sent" only once EVERY member's own e-mail is confirmed. */
async function refreshAggregate(deps: SendDeps, rec: TrackingRecord, ledger: readonly SendRecord[], conn: Connection | undefined, fallback?: { status: SendStatus; reason: string; lastError?: string }) {
  const sent = sentRowsFor(ledger, rec);
  const rows = [...sent.values()];
  const all = sent.size === MEMBER_IDS.length;
  const patch: Partial<TrackingRecord> = {
    sendStatus: all ? "sent" : fallback?.status ?? (sent.size ? "pending" : rec.sendStatus === "disabled" ? "pending" : rec.sendStatus),
    sendBlockReason: all ? "" : fallback?.reason ?? rec.sendBlockReason,
    sentBy: [...sent.keys()].join(","),
    gmailAccount: [...new Set(rows.map((r) => r.gmailAccount))].join(","),
    gmailMessageId: rows.map((r) => r.gmailMessageId).join(","),
    resumeSent: rows.map((r) => r.resumeFile).join("; "),
    sentAt: rows.map((r) => r.sentAt).sort().pop() ?? rec.sentAt,
    sendAttempts: Math.max(rec.sendAttempts, ...rows.map((r) => r.attempts)),
    ...(fallback?.lastError ? { lastError: fallback.lastError } : sent.size ? { lastError: "" } : {}),
  };
  const changed = (Object.keys(patch) as (keyof TrackingRecord)[]).some((k) => patch[k] !== rec[k]);
  if (changed) await patchTracking(deps, rec, patch);
  if (all && conn && conn.status === "Not Connected") await deps.connections.markMessaged(conn).catch(() => undefined);
}

const RETRY_AFTER_TRANSIENT_MS = 10 * 60_000;
const RETRY_AFTER_AUTH_MS = 60 * 60_000;
const RETRY_AFTER_RATE_MS = 15 * 60_000;
/** A send that was started but has no recorded result is only reconciled once it is this old (Gmail may still be finishing it). */
const RECONCILE_AFTER_MS = 2 * 60_000;

/** Interrupted / uncertain sends are reconciled against Gmail BEFORE anything else is sent. Never retries a send. */
async function reconcileInFlight(deps: SendDeps, result: SendRunResult, trackingAll: TrackingRecord[], conns: Map<string, Connection>, ledgerAll: SendRecord[]) {
  const nowMs = deps.now().getTime();
  for (const r of ledgerAll) {
    if (r.status !== "sending" && r.status !== "uncertain") continue;
    if (nowMs - Date.parse(r.updatedAt || r.createdAt) < RECONCILE_AFTER_MS) continue;
    if (result.reconciled >= 5) break;
    const rec = trackingAll.find((t) => t.contactId === r.contactId);
    const verdict = await deps.gmail.reconcile(r.member as MemberId, r.draftId, r.threadId || undefined).catch((): Reconciliation => ({ state: "unknown", reason: "reconcile failed" }));
    result.reconciled += 1;
    if (verdict.state === "sent") {
      await finishSent(deps, r, verdict.messageId ?? "", r.threadId || undefined, "confirmed by reconciliation");
      if (rec) await refreshAggregate(deps, rec, ledgerAll, conns.get(r.connectionId));
    } else if (verdict.state === "not_sent") {
      await patchLedger(deps, r, { status: "failed_transient", notBefore: new Date(nowMs + RETRY_AFTER_TRANSIENT_MS).toISOString(), reason: "Gmail shows the send did not happen" }, "reconciled: not sent, safe to retry later");
    } else {
      if (r.status !== "uncertain" || r.reason !== verdict.reason) await patchLedger(deps, r, { status: "uncertain", reason: verdict.reason }, `reconciled: unknown (${verdict.reason})`);
      if (rec) await refreshAggregate(deps, rec, ledgerAll, conns.get(r.connectionId), { status: "uncertain", reason: `${r.member}: send result could not be confirmed: ${verdict.reason}` });
    }
  }
}

const RANK: Record<SendStatus, number> = { disabled: 0, pending: 1, blocked: 2, claimed: 3, failed: 4, review: 5, uncertain: 6, sent: 0 };

export async function runSendStep(deps: SendDeps): Promise<SendRunResult> {
  if (!deps.gate) return zero("disabled"); // defence in depth: refuses before reading or writing anything
  const result = zero("ran");
  const now = deps.now();

  await releaseStaleClaims(deps.sheet, now);
  const tracking = (await deps.sheet.readTracking()).records;
  const conns = new Map((await deps.connections.listFresh()).map((c) => [c.connectionId, c]));
  // The ledger is read once here and re-read only after this step writes to it.
  let ledgerAll = (await deps.sheet.readSendLedger()).records;
  await reconcileInFlight(deps, result, tracking, conns, ledgerAll);

  const parsed = parseMasterRows(await deps.sheet.readMaster());
  const first = firstInDuplicateGroups(parsed.contacts);
  const eligibleIds = new Set(parsed.contacts.filter((c) => importEligibility(c, first).eligible).map((c) => c.contactId));
  const exclusions = await deps.sheet.readExclusions();
  const drafts = await deps.drafts.snapshot();
  const addresses = new Map<MemberId, string | null>();
  for (const m of MEMBER_IDS) addresses.set(m, await deps.gmail.address(m));

  // Oldest first. A contact is finished only when ALL members' e-mails are confirmed.
  const candidates = tracking
    .filter((t) => t.importStatus === "added" && t.connectionId && t.sendStatus !== "sent")
    .sort((a, b) => (a.addedAt || a.claimedAt).localeCompare(b.addedAt || b.claimedAt));

  outer: for (const rec of candidates) {
    if (result.sent >= deps.limits.perRun) { result.stoppedBecause = "per-run-limit"; break; }
    let worst: { status: SendStatus; reason: string; lastError?: string } | null = null;
    const note = (status: SendStatus, reason: string, lastError?: string) => { if (!worst || RANK[status] > RANK[worst.status]) worst = { status, reason: reason.slice(0, 480), ...(lastError ? { lastError } : {}) }; };
    for (const member of MEMBER_IDS) {
      if (result.sent >= deps.limits.perRun) { result.stoppedBecause = "per-run-limit"; break outer; }
      if (deps.deadline !== undefined && Date.now() > deps.deadline) { result.stoppedBecause = "deadline"; break outer; }
      try {
        const ev = await evaluate(deps, rec, member, { connections: conns, drafts, ledger: ledgerAll, tracking, exclusions, eligibleIds: parsed.contacts.length ? eligibleIds : null, addresses });
        if (ev.kind !== "send") {
          if (ev.kind === "done") { result.duplicatesPrevented += 1; continue; } // this member's own e-mail is already sent: nothing more to do for them
          if (ev.kind === "block" && ev.check === "no_prior_send" && /is uncertain/.test(ev.reason)) { note("uncertain", `${member}: ${ev.reason}`, "uncertain"); continue; } // waits for a person; never resent
          if (ev.check === "no_prior_send") result.duplicatesPrevented += 1;
          if (ev.kind === "review") result.needsReview += 1;
          else if (ev.kind === "wait" || ev.kind === "auth") result.waiting += 1;
          else result.blocked += 1;
          note(ev.kind === "review" ? "review" : ev.kind === "block" ? "blocked" : "pending", `${member}: [${ev.check}] ${ev.reason}`);
          continue;
        }
        const ctx = ev.ctx;
        const day = dateInTimezone(now, deps.timezone);
        const claim = await claimSend(deps.sheet, {
          sendKey: sendKeyFor(member, rec.email), contactId: rec.contactId, member: ctx.member, gmailAccount: ctx.address, connectionId: rec.connectionId, company: ctx.connection.company ?? "", role: ctx.role,
          draftId: ctx.draft.gmailDraftId, threadId: ctx.readback.threadId ?? ctx.draft.threadId ?? "", resumeFile: ctx.resume.fileName, resumeSha256: ctx.resume.sha256, resumeBytes: ctx.resume.bytes, wordCount: ctx.words,
        }, day, now, (after, mine) => {
          // Concurrent workers cannot overshoot: claims ahead of this one (sheet row order) use the allowance first.
          const nowMs = deps.now().getTime();
          const ahead = after.filter((r) => r.row < mine.row && countsAgainstLimit(r, nowMs));
          if (ahead.length + 1 > deps.limits.globalDaily) return "combined rolling 24-hour sending limit reached (concurrent worker)";
          if (ahead.filter((r) => r.member === member).length + 1 > deps.limits.perMemberDaily) return `${member}'s rolling 24-hour sending limit reached (concurrent worker)`;
          return null;
        });
        ledgerAll = (await deps.sheet.readSendLedger()).records;
        if (!claim.won) {
          if (claim.reason === "limit_reached") note("pending", `${member}: rolling 24-hour limit reached`);
          else result.duplicatesPrevented += 1;
          if (claim.reason === "needs_review" || claim.reason === "failed_permanent" || claim.reason === "too_many_attempts") note("review", `${member}: [no_prior_send] ${claim.reason.replace(/_/g, " ")}`);
          continue;
        }
        let row = claim.record;
        // Persist "sending" BEFORE the Gmail call: a crash after this point is reconciled, never blindly retried.
        await patchLedger(deps, row, { status: "sending", draftId: ctx.draft.gmailDraftId }, "sending");
        const out = await deps.gmail.send(ctx.member, ctx.draft.gmailDraftId);

        if (out.status === "sent") {
          await finishSent(deps, row, out.messageId, out.threadId, "confirmed by Gmail");
          result.sent += 1;
        } else if (out.status === "rate_limited") {
          const wait = Math.max(out.retryAfterMs ?? 0, RETRY_AFTER_RATE_MS);
          await patchLedger(deps, row, { status: "failed_transient", notBefore: new Date(now.getTime() + wait).toISOString(), reason: "Gmail rate limit / quota" }, "rate limited; nothing was sent");
          note("failed", `${member}: [gmail_auth] Gmail rate limit reached; will retry later`, "rate_limited");
          result.failed += 1;
          result.stoppedBecause = "rate-limited";
          ledgerAll = (await deps.sheet.readSendLedger()).records;
          await refreshAggregate(deps, rec, ledgerAll, conns.get(rec.connectionId), worst ?? undefined);
          break outer;
        } else if (out.status === "auth_failed" || out.status === "no_access") {
          const reason = out.status === "auth_failed" ? out.reason : `no Gmail access (${out.access})`;
          await patchLedger(deps, row, { status: "failed_transient", notBefore: new Date(now.getTime() + RETRY_AFTER_AUTH_MS).toISOString(), reason }, "authorisation failure; nothing was sent");
          note("failed", `${member}: [gmail_auth] ${reason}`, "auth");
          result.failed += 1;
        } else if (out.status === "rejected") {
          await patchLedger(deps, row, { status: "failed_permanent", reason: out.reason }, "rejected by Gmail; will not be retried");
          note("review", `${member}: [valid_email] Gmail rejected the message: ${out.reason}`, "rejected");
          result.needsReview += 1;
        } else {
          // uncertain (timeout, 5xx, unconfirmed 2xx, or "draft missing" which may mean it was already sent): reconcile NOW, never resend.
          row = (await deps.sheet.readSendLedger()).records.find((r) => r.claimId === row.claimId) ?? row;
          await patchLedger(deps, row, { status: "uncertain", reason: out.status === "uncertain" ? out.reason : "draft not found after the send request" }, "uncertain send result; reconciling");
          const verdict = await deps.gmail.reconcile(ctx.member, ctx.draft.gmailDraftId, row.threadId || undefined).catch((): Reconciliation => ({ state: "unknown", reason: "reconcile failed" }));
          result.reconciled += 1;
          if (verdict.state === "sent") {
            await finishSent(deps, row, verdict.messageId ?? "", row.threadId || undefined, "confirmed by reconciliation");
            result.sent += 1;
          } else if (verdict.state === "not_sent") {
            await patchLedger(deps, row, { status: "failed_transient", notBefore: new Date(now.getTime() + RETRY_AFTER_TRANSIENT_MS).toISOString(), reason: "Gmail shows the send did not happen" }, "reconciled: not sent, safe to retry later");
            note("failed", `${member}: [gmail_auth] the send did not go through; it will be retried`, "transient");
            result.failed += 1;
          } else {
            await patchLedger(deps, row, { status: "uncertain", reason: verdict.reason }, `reconciled: unknown (${verdict.reason})`);
            note("uncertain", `${member}: send result could not be confirmed: ${verdict.reason}`, "uncertain");
            result.needsReview += 1;
          }
        }
        ledgerAll = (await deps.sheet.readSendLedger()).records;
      } catch (err) {
        // An unexpected exception can never turn into a send: nothing here sends after a throw; the next call re-evaluates from the ledger.
        result.errors.push(err instanceof Error ? err.name : "error");
        result.stoppedBecause = "error";
        break outer;
      }
    }
    try {
      await refreshAggregate(deps, rec, ledgerAll, conns.get(rec.connectionId), worst ?? undefined);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.name : "error");
    }
  }
  return result;
}
