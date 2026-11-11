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
 *   F  already sent outside JobSync  -> Gmail's labels say the draft's message is SENT (or the id is not a draft at all): NOT sent again, NOT counted as
 *                                       ours, parked with the reason, and the next draft/member is processed at once
 * Counters are derived from the confirmed rows this module writes.
 */
import { createHash } from "node:crypto";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import type { DraftInspection, DraftReadback, Reconciliation, ReadResult, SendOutcome } from "@/lib/gmail/send";
import type { ResumeLookup } from "@/lib/gmail/attachment";
import { normalizeEmail } from "@/lib/hr-master/normalize";
import { dateInTimezone } from "@/lib/utils/time";
import type { Connection } from "@/types/domain";
import { eligibleIdSet, importEligibility, firstInDuplicateGroups, parseMasterRows } from "./contacts";
import { resolvePriorityContacts } from "./priority";
import { checkAttachment, checkDraft } from "./draft-check";
import { isExcluded, matchesAllowlist } from "./exclusions";
import { MAX_SEND_ATTEMPTS, RATE_LIMIT_REASON, claimSend, countedFailures, normalKey, releaseStaleClaims, rowsFor, sendKeyFor, withHistory } from "./send-ledger";
import type { OutreachSheet } from "./sheet";
import { draftKeyFor } from "./sync";
import { hasReviewFlag, normalizeParkReason, parkedReasonOf } from "@/lib/gmail/draft-flags";
import { MEMBER_RESUME_FILES } from "@/config/resume-map";
import type { SendRecord, SendStatus, TrackingRecord } from "./types";

/** The fourteen pre-send validations, in the order they are reported (evaluation order is cheap-first, see `evaluate`). */
export const CHECKS = [
  "valid_email", "eligible", "connection", "owner", "member_identity", "email_generated", "content_supported", "word_limit",
  "not_already_received", "not_excluded", "no_prior_send", "resume", "gmail_auth", "gmail_quota",
] as const;
export type CheckId = (typeof CHECKS)[number];

export interface GmailPort {
  /** The member's connected Gmail address, or null when not connected. */
  address(member: MemberId): Promise<string | null>;
  readDraft(member: MemberId, draftId: string): Promise<ReadResult>;
  send(member: MemberId, draftId: string): Promise<SendOutcome | { status: "no_access"; access: string }>;
  /** `sinceMs`: when this send attempt began; a SENT message older than that was sent outside JobSync. */
  reconcile(member: MemberId, draftId: string, threadId: string | undefined, sinceMs?: number): Promise<Reconciliation>;
  /** Read-only look at Gmail's real state of a draft id, used after Gmail answered "Message not a draft". */
  inspect(member: MemberId, draftId: string, threadId: string | undefined): Promise<DraftInspection>;
}

/** Which ledger drafts still exist in the member's Gmail Drafts folder (the cached drafts.list the backlog gate uses). "unknown" never skips anything. */
export interface DraftPresencePort {
  has(member: MemberId, gmailDraftId: string): Promise<"present" | "absent" | "unknown">;
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
  sheet: Pick<OutreachSheet, "readTracking" | "updateTracking" | "readSendLedger" | "appendSendRecord" | "updateSendRecord" | "readExclusions" | "readMaster"> & Partial<Pick<OutreachSheet, "readPriority">>;
  gmail: GmailPort;
  /**
   * The owner's explicit instruction (config sendAllDrafts): send every JobSync draft that carries the member's own resume even when it fails the content checks. Only the
   * content checks are relaxed (word limit, wording, review/parked flags, resume size/role choice); recipient, other-member, label, opt-out, duplicate and identity checks stay.
   */
  relaxContentChecks?: boolean;
  /** Optional cheap pre-filter: skips ledger drafts that are no longer in Gmail before any per-draft Gmail call or claim. Absent = every draft is read. */
  presence?: DraftPresencePort;
  resumes: ResumeLookup;
  connections: { listFresh(): Promise<Connection[]>; markMessaged(c: Connection): Promise<void> };
  drafts: {
    snapshot(): Promise<ReadonlyMap<string, DraftInfo>>;
    markSent(member: MemberId, connectionId: string): Promise<void>;
    /**
     * Records on the draft ledger row WHY the send step cannot send this draft (reason) or clears that note (null). It only edits the ledger
     * row's note: the draft in Gmail is never touched. A parked draft stays in Gmail but leaves the eligible backlog the drafting gate counts.
     */
    setParked?(member: MemberId, connectionId: string, reason: string | null): Promise<void>;
  };
  now: () => Date;
  timezone: string;
  deadline?: number;
  /**
   * A contact that needs a person (marked "review" or "blocked", or whose open drafts are ALL already recorded as unsendable, "parked") is re-checked
   * only on every Nth call (a stateless rotation by contact), and contacts that do not need a person are always looked at first, so hundreds of them cannot
   * use up every call's time and Sheets quota. 1 (default) = unchanged: every contact on every call, oldest first. Production sets 15 (about every 30 minutes).
   */
  reviewRecheckEvery?: number;
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
  /** "rate-limited": Gmail refused at least one member's send for quota reasons (that member pauses; the others continue). "deadline": the time budget of this call ran out; the next call continues. */
  stoppedBecause: "none" | "rate-limited" | "deadline" | "error";
  /** Drafts newly recorded as "cannot be sent, needs a person" (parked) or released from that note in this call. */
  parkedChanges?: number;
  /** Drafts skipped in this call because Gmail proved their message was already SENT outside JobSync (never counted in `sent`). */
  externallySent?: number;
  /** Drafts skipped in this call because they are no longer drafts in Gmail (not in the Drafts folder), without a claim or a send. */
  staleSkipped?: number;
  errors: string[];
}

const zero = (status: SendRunResult["status"]): SendRunResult => ({ status, sent: 0, blocked: 0, needsReview: 0, failed: 0, waiting: 0, duplicatesPrevented: 0, reconciled: 0, stoppedBecause: "none", parkedChanges: 0, errors: [] });

type Evaluation =
  | { kind: "send"; ctx: SendContext }
  | { kind: "done"; check: CheckId; reason: string }
  | { kind: "wait"; check: CheckId; reason: string }
  | { kind: "block"; check: CheckId; reason: string }
  | { kind: "review"; check: CheckId; reason: string }
  | { kind: "auth"; check: CheckId; reason: string }
  /** The draft is no longer a sendable draft in Gmail. `sentOutside`: Gmail proved the message is SENT; otherwise it is simply not in the Drafts folder. Skipped, parked, never sent. */
  | { kind: "stale"; check: CheckId; reason: string; sentOutside: boolean };

const STALE_NOT_LISTED = "no longer in the member's Gmail Drafts (already sent or deleted outside JobSync)";
const STALE_SENT = "already sent outside JobSync (Gmail marks this message SENT)";

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
  // Judged for THIS member only, from the durable send ledger. The contact-level "sent" flag is not consulted: it describes the contact as a whole and
  // can be set while another member's e-mail is still to be sent.
  if (priorLedger?.status === "sent") return { kind: "done", check: "no_prior_send", reason: `${member}'s message to this recipient was already sent successfully` };
  if (priorLedger) return { kind: "block", check: "no_prior_send", reason: `another send to this recipient is ${priorLedger.status}` };
  if (rowsFor(env.ledger, key).some((r) => r.status === "needs_review" || r.status === "failed_permanent")) return { kind: "review", check: "no_prior_send", reason: "an earlier send attempt needs manual review" };
  if (rowsFor(env.ledger, key).some((r) => r.status === "sent_outside")) return { kind: "stale", check: "not_already_received", sentOutside: true, reason: STALE_SENT };
  if (env.drafts.get(draftKeyFor(rec.connectionId, member))?.status === "sent") return { kind: "done", check: "not_already_received", reason: `${member} already sent this message from their own Gmail` };
  const emailKey = normalKey(email.email);
  // The same recipient on another record, already e-mailed BY THIS MEMBER (their draft there is sent): a member never e-mails the same address twice.
  if (env.tracking.some((t) => t !== rec && normalKey(t.email) === emailKey && env.drafts.get(draftKeyFor(t.connectionId, member))?.status === "sent")) return { kind: "done", check: "not_already_received", reason: "this recipient already received outreach through another record" };

  const address = env.addresses.get(member) ?? null;
  if (!address) return { kind: "auth", check: "member_identity", reason: `${member}'s Gmail is not connected` };

  const draft = env.drafts.get(draftKeyFor(rec.connectionId, member));
  if (!draft || draft.status === "skipped_unauthorized") return { kind: "wait", check: "email_generated", reason: "waiting for the personalised draft in the member's mailbox" };
  if (draft.status !== "created") return { kind: "block", check: "email_generated", reason: `the member's draft is "${draft.status}"` };
  if (!draft.gmailDraftId) return { kind: "wait", check: "email_generated", reason: "the member's draft has no Gmail id yet" };
  const flagged = draft.detail.split("; ").filter((p) => p.startsWith("review:")).map((p) => p.slice(7).trim());
  if (flagged.length && !deps.relaxContentChecks) return { kind: "review", check: /resume|attachment/i.test(flagged.join(" ")) ? "resume" : "content_supported", reason: flagged.join(" | ") };

  // A transient failure is retried only after its back-off, and only a limited number of times.
  const mine = rowsFor(env.ledger, key);
  const backoff = mine.filter((r) => r.status === "failed_transient" && r.notBefore && Date.parse(r.notBefore) > deps.now().getTime()).sort((a, b) => b.notBefore.localeCompare(a.notBefore))[0];
  if (backoff) return { kind: "wait", check: "gmail_auth", reason: `retry scheduled after ${backoff.notBefore} (${backoff.reason})` };
  if (countedFailures(mine) >= MAX_SEND_ATTEMPTS) return { kind: "review", check: "gmail_auth", reason: `${MAX_SEND_ATTEMPTS} send attempts failed; manual review needed` };

  // Gmail's OWN quota: after Gmail refused this member's account for rate/quota reasons, no further send is attempted from it until the cool-down
  // ends (derived from the durable ledger, so it also holds across cron calls). This is Gmail's limit, not a JobSync cap; other members continue.
  const cooling = env.ledger
    .filter((r) => r.member === member && r.status === "failed_transient" && r.reason === RATE_LIMIT_REASON && r.notBefore && Date.parse(r.notBefore) > deps.now().getTime())
    .sort((a, b) => b.notBefore.localeCompare(a.notBefore))[0];
  if (cooling) return { kind: "wait", check: "gmail_quota", reason: `Gmail asked ${member}'s account to slow down; sending resumes after ${cooling.notBefore}` };

  // Cheap pre-filter from the cached drafts.list: a ledger draft that is not in the member's Drafts folder is not a pending draft. No per-draft Gmail
  // call, no claim and no send. Only a complete, successful listing can say "absent"; any doubt ("unknown") falls through to the full verification below.
  if (deps.presence) {
    const where = await deps.presence.has(member, draft.gmailDraftId).catch((): "unknown" => "unknown");
    if (where === "absent") return { kind: "stale", check: "email_generated", sentOutside: false, reason: STALE_NOT_LISTED };
  }

  // Gmail is read only now. The REAL saved draft is what gets verified.
  const read = await deps.gmail.readDraft(member, draft.gmailDraftId);
  if (read.status === "no_access") return { kind: "auth", check: "gmail_auth", reason: `Gmail authorisation for ${member} is not valid (${read.access})` };
  if (read.status === "not_found") return { kind: "block", check: "email_generated", reason: "the draft no longer exists in Gmail (deleted or already sent)" };
  if (read.status === "error") return { kind: "wait", check: "gmail_auth", reason: `Gmail could not be read (${read.reason})` };

  // The labels of the saved message decide whether it can be sent AT ALL. Gmail keeps resolving the id of a draft that was already sent (labelled SENT),
  // so "the draft was readable" proves nothing. drafts.send is only reached for a message that is labelled DRAFT and not SENT.
  const labels = read.draft.labelIds;
  if (!labels) return { kind: "wait", check: "gmail_auth", reason: "Gmail did not report the draft's labels; nothing is sent until it does" };
  if (labels.includes("SENT")) return { kind: "stale", check: "not_already_received", sentOutside: true, reason: STALE_SENT };
  if (!labels.includes("DRAFT")) return { kind: "stale", check: "email_generated", sentOutside: false, reason: `no longer a draft in Gmail (labels: ${labels.join(",") || "none"})` };

  const role = (conn.applyRole || rec.targetRole || "").trim();
  const check = checkDraft(read.draft, { member, recipientEmail: email.email, personName: conn.name, companyName: conn.company ?? "", applyRole: role });
  if (deps.relaxContentChecks) {
    // Only identity-level failures survive: the wrong recipient, or text about another member. Word limit, wording, placeholders etc. are the owner's call.
    const hard = check.failures.filter((x) => x.check === "recipient" || /another member/.test(x.reason));
    if (hard.length) return { kind: "review", check: hard[0].check === "recipient" ? "valid_email" : "content_supported", reason: hard.map((x) => x.reason).join(" | ") };
    // The resume must be in the draft and be THIS member's own (by file name); the stale-version size check and the role-based choice are not applied.
    const own = new Set(Object.values(MEMBER_RESUME_FILES[member] ?? {}).map((n) => (n as string).toLowerCase()));
    const foreign = new Set(MEMBER_IDS.filter((m) => m !== member).flatMap((m) => Object.values(MEMBER_RESUME_FILES[m] ?? {}).map((n) => (n as string).toLowerCase())).filter((n) => !own.has(n)));
    const attached = read.draft.attachments;
    if (attached.some((a) => foreign.has(a.filename.toLowerCase()))) return { kind: "review", check: "resume", reason: "the draft carries another member's resume" };
    const mine = attached.find((a) => own.has(a.filename.toLowerCase()));
    if (!mine) return { kind: "review", check: "resume", reason: "the draft has none of this member's resumes attached" };
    return { kind: "send", ctx: { member, connection: conn, draft, readback: read.draft, address, role, resume: { fileName: mine.filename, bytes: mine.size, sha256: "draft-attachment" }, words: check.words } };
  }
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

/** SendKeys (member|recipient) with a confirmed send in the durable send ledger. */
export const confirmedSendKeys = (ledger: readonly SendRecord[]): Set<string> => new Set(ledger.filter((r) => r.status === "sent").map((r) => r.sendKey));

/**
 * The members who still have an UNSENT draft for this contact, judged only from the two durable ledgers: the draft ledger (a draft exists and is not
 * sent) and the send ledger (no confirmed send for that member and recipient). The contact's own "sent" flag is never consulted: it can be set while a
 * member's draft was still missing (a draft created later is just as eligible), and a confirmed send is never repeated because the send ledger says so.
 */
export function outstandingMembers(rec: Pick<TrackingRecord, "connectionId" | "email">, drafts: ReadonlyMap<string, { status: string }>, sentKeys: ReadonlySet<string>): MemberId[] {
  return MEMBER_IDS.filter((m) => drafts.get(draftKeyFor(rec.connectionId, m))?.status === "created" && !sentKeys.has(sendKeyFor(m, rec.email)));
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

/** Bookkeeping bound per call: notes written to the draft ledger (each is a Sheets read and write). It never limits sending. */
const MAX_PARK_WRITES_PER_RUN = 25;
/** Parking always gets at least this long after the walk, even when sending used the whole slice (sending is never delayed by it, it runs afterwards). */
const MIN_PARK_PASS_MS = 3_000;

/** When the Gmail request of an attempt began, from the ledger's own history (the last "<iso> sending" event); undefined when it cannot be read. */
export function attemptStartOf(history: string): number | undefined {
  let at: number | undefined;
  for (const m of history.matchAll(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z) sending(?=;|$)/g)) at = Date.parse(m[1]);
  return at !== undefined && Number.isFinite(at) ? at : undefined;
}

const sentOutsideReason = (messageId: string) => `${STALE_SENT}; message ${messageId}`;
/** One cron call per slot (the cron runs every ~2 minutes); used to rotate which already-parked contacts are re-checked. */
const RUN_SLOT_MS = 120_000;
const hashOf = (s: string) => [...s].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
const RETRY_AFTER_TRANSIENT_MS = 10 * 60_000;
const RETRY_AFTER_AUTH_MS = 60 * 60_000;
const RETRY_AFTER_RATE_MS = 15 * 60_000;
/** Gmail refusals of one account closer together than this escalate its back-off. */
const RATE_ESCALATION_WINDOW_MS = 6 * 60 * 60_000;
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
    const verdict = await deps.gmail.reconcile(r.member as MemberId, r.draftId, r.threadId || undefined, attemptStartOf(r.history)).catch((): Reconciliation => ({ state: "unknown", reason: "reconcile failed" }));
    result.reconciled += 1;
    if (verdict.state === "sent") {
      await finishSent(deps, r, verdict.messageId ?? "", r.threadId || undefined, "confirmed by reconciliation");
      if (rec) await refreshAggregate(deps, rec, ledgerAll, conns.get(r.connectionId));
    } else if (verdict.state === "external") {
      await patchLedger(deps, r, { status: "sent_outside", reason: verdict.reason }, "reconciled: sent outside JobSync before this attempt; not counted as ours");
      await deps.drafts.setParked?.(r.member as MemberId, r.connectionId, normalizeParkReason(STALE_SENT)).catch(() => undefined);
      result.externallySent = (result.externallySent ?? 0) + 1;
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
  // Contacts of the optional Priority Contacts tab are eligible on exactly the same rules as Master Contacts (the eligible Master set is computed once per cached grid).
  const priority = deps.sheet.readPriority ? resolvePriorityContacts(await deps.sheet.readPriority(), parsed) : { contacts: [] as typeof parsed.contacts };
  const masterEligible = eligibleIdSet(parsed);
  const eligibleIds = priority.contacts.length
    ? new Set([...masterEligible, ...priority.contacts.filter((c) => importEligibility(c, first).eligible).map((c) => c.contactId)])
    : masterEligible;
  const exclusions = await deps.sheet.readExclusions();
  // A local copy: a parked note written below is reflected at once, so the same draft is never rewritten twice in one call.
  const drafts = new Map(await deps.drafts.snapshot());
  const addresses = new Map<MemberId, string | null>();
  for (const m of MEMBER_IDS) addresses.set(m, await deps.gmail.address(m));

  // Oldest first. A contact is finished only when ALL members' e-mails are confirmed. A contact flagged "sent" is still a candidate when some member
  // has an unsent draft (see outstandingMembers); a contact whose every draft is sent is skipped without a single Gmail call.
  const sentKeys = confirmedSendKeys(ledgerAll);
  const candidates = tracking
    .filter((t) => t.importStatus === "added" && t.connectionId && (t.sendStatus !== "sent" || outstandingMembers(t, drafts, sentKeys).length > 0))
    .sort((a, b) => (a.addedAt || a.claimedAt).localeCompare(b.addedAt || b.claimedAt));
  // Drafts already recorded as "cannot be sent" are looked at LAST (they are re-checked with whatever time is left, in case something changed), so
  // they can never use up the time slice that eligible drafts need. Oldest first within each group.
  const parkedRec = (t: TrackingRecord) => {
    const open = MEMBER_IDS.map((m) => drafts.get(draftKeyFor(t.connectionId, m))).filter((d) => d?.status === "created");
    return open.length > 0 && open.every((d) => hasReviewFlag(d!.detail) || parkedReasonOf(d!.detail) !== null);
  };
  const every = Math.max(1, deps.reviewRecheckEvery ?? 1);
  // A contact that needs a person: all its open drafts are recorded as unsendable ("parked"), or (with rotation on) it is marked "review" or "blocked".
  const needsPerson = (t: TrackingRecord) => parkedRec(t) || (every > 1 && (t.sendStatus === "review" || t.sendStatus === "blocked"));
  candidates.sort((a, b) => Number(needsPerson(a)) - Number(needsPerson(b))); // stable: oldest first inside each group
  const slot = Math.floor(deps.now().getTime() / RUN_SLOT_MS);
  const dueForRecheck = (t: TrackingRecord) => every === 1 || (hashOf(t.contactId) + slot) % every === 0;
  let parkBudget = MAX_PARK_WRITES_PER_RUN;
  // Parked notes are bookkeeping (a Sheets read + write each). They are queued while the contacts are walked and written AFTER the walk, so they can
  // never use up the time slice the sends need. A note that is not written in this call is simply found again by the next one.
  const parkQueue: { member: MemberId; connectionId: string; want: string | null }[] = [];
  /** Keeps the draft ledger's "parked" note equal to what this call just found out. Best effort: a failed note never affects sending. */
  const syncParked = async (member: MemberId, rec: TrackingRecord, ev: Evaluation) => {
    if (!deps.drafts.setParked) return;
    const key = draftKeyFor(rec.connectionId, member);
    const d = drafts.get(key);
    if (!d || d.status !== "created" || hasReviewFlag(d.detail)) return; // not a pending draft, or already flagged by the drafting step
    let reason: string | null = null;
    if (ev.kind === "review" || ev.kind === "done" || ev.kind === "stale") reason = ev.reason;
    else if (ev.kind === "block" && !(ev.check === "no_prior_send" && /is (claimed|sending|uncertain)/.test(ev.reason)) && !/no longer exists/.test(ev.reason)) reason = ev.reason;
    const want = reason ? normalizeParkReason(reason) : null;
    if ((parkedReasonOf(d.detail) ?? null) === want) return;
    if (parkBudget <= 0) return;
    parkBudget -= 1;
    parkQueue.push({ member, connectionId: rec.connectionId, want });
    // The local copy reflects the note at once, so the same draft is never queued twice in one call.
    drafts.set(key, { ...d, detail: want ? `${d.detail}${d.detail ? "; " : ""}parked: ${want}` : d.detail.split("; ").filter((x) => !x.startsWith("parked:")).join("; ") });
  };
  /** Writes the queued notes after the walk: until the call's send deadline, but always for at least MIN_PARK_PASS_MS so the backlog of stale notes keeps draining. */
  const flushParks = async () => {
    if (!deps.drafts.setParked) return;
    const until = Math.max(deps.deadline ?? 0, Date.now() + MIN_PARK_PASS_MS);
    for (const p of parkQueue) {
      if (Date.now() > until) break;
      try {
        await deps.drafts.setParked(p.member, p.connectionId, p.want);
        result.parkedChanges = (result.parkedChanges ?? 0) + 1;
      } catch {
        // bookkeeping only: nothing was sent or claimed because of it, and the next call finds the same draft again
      }
    }
  };

  // No count limit: every eligible e-mail is attempted until the time budget of this call runs out; the next cron call continues.
  outer: for (const rec of candidates) {
    if (every > 1 && needsPerson(rec) && !dueForRecheck(rec)) continue; // needs a person and is not due for its periodic re-check
    let worst: { status: SendStatus; reason: string; lastError?: string } | null = null;
    const note = (status: SendStatus, reason: string, lastError?: string) => { if (!worst || RANK[status] > RANK[worst.status]) worst = { status, reason: reason.slice(0, 480), ...(lastError ? { lastError } : {}) }; };
    for (const member of MEMBER_IDS) {
      if (deps.deadline !== undefined && Date.now() > deps.deadline) { result.stoppedBecause = "deadline"; break outer; }
      try {
        const ev = await evaluate(deps, rec, member, { connections: conns, drafts, ledger: ledgerAll, tracking, exclusions, eligibleIds: parsed.contacts.length + priority.contacts.length ? eligibleIds : null, addresses });
        if (ev.kind !== "send") await syncParked(member, rec, ev);
        if (ev.kind !== "send") {
          // A stale draft costs nothing: no claim, no send, no ledger row. The next member / contact is processed straight away.
          if (ev.kind === "stale") {
            if (ev.sentOutside) result.externallySent = (result.externallySent ?? 0) + 1;
            else result.staleSkipped = (result.staleSkipped ?? 0) + 1;
            continue;
          }
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
        }, day, now);
        ledgerAll = claim.won ? claim.ledger : (await deps.sheet.readSendLedger()).records; // a won claim has just read the ledger: no second read
        if (!claim.won) {
          result.duplicatesPrevented += 1;
          if (claim.reason === "sent_outside") result.externallySent = (result.externallySent ?? 0) + 1;
          if (claim.reason === "needs_review" || claim.reason === "failed_permanent" || claim.reason === "too_many_attempts") note("review", `${member}: [no_prior_send] ${claim.reason.replace(/_/g, " ")}`);
          continue;
        }
        let row = claim.record;
        // FINAL label check, after the claim and immediately before the send. The cached listing and the readback made in evaluate() are only pre-filters:
        // by now they are seconds old. A draft that is not (still) a DRAFT is never sent; if Gmail cannot say, nothing is sent and the claim is released.
        const last = await deps.gmail.inspect(ctx.member, ctx.draft.gmailDraftId, ctx.readback.threadId ?? ctx.draft.threadId).catch((): DraftInspection => ({ state: "unknown", reason: "Gmail could not be queried" }));
        if (last.state !== "pending_draft") {
          if (last.state === "sent_outside") {
            await patchLedger(deps, row, { status: "sent_outside", reason: sentOutsideReason(last.messageId) }, "final check before sending: already SENT outside JobSync; nothing was sent by this system");
            await syncParked(member, rec, { kind: "stale", check: "not_already_received", sentOutside: true, reason: STALE_SENT });
            result.externallySent = (result.externallySent ?? 0) + 1;
          } else {
            await patchLedger(deps, row, { status: "released", reason: "final Gmail check could not confirm the draft; nothing was sent" }, `released: final check unavailable (${last.reason}); nothing sent, safe to retry`);
            note("pending", `${member}: [gmail_auth] Gmail could not confirm the draft just before sending (${last.reason}); will retry`);
            result.waiting += 1;
          }
          ledgerAll = (await deps.sheet.readSendLedger()).records;
          continue;
        }
        // Persist "sending" BEFORE the Gmail call: a crash after this point is reconciled, never blindly retried.
        await patchLedger(deps, row, { status: "sending", draftId: ctx.draft.gmailDraftId }, "sending");
        // The moment the Gmail request begins (taken after the ledger write): a SENT message older than this can never be this attempt's.
        const attemptStartedMs = deps.now().getTime();
        const out = await deps.gmail.send(ctx.member, ctx.draft.gmailDraftId);

        if (out.status === "sent") {
          await finishSent(deps, row, out.messageId, out.threadId, "confirmed by Gmail");
          result.sent += 1;
        } else if (out.status === "rate_limited") {
          // Back off harder while Gmail keeps refusing this account (a daily quota lasts hours): 15, 30, 60, 120, then 240 minutes.
          const recentRefusals = ledgerAll.filter((r) => r.member === member && r.reason === RATE_LIMIT_REASON && now.getTime() - Date.parse(r.updatedAt || r.createdAt) < RATE_ESCALATION_WINDOW_MS).length;
          const wait = Math.max(out.retryAfterMs ?? 0, RETRY_AFTER_RATE_MS * 2 ** Math.min(recentRefusals, 4));
          await patchLedger(deps, row, { status: "failed_transient", notBefore: new Date(now.getTime() + wait).toISOString(), reason: RATE_LIMIT_REASON }, "rate limited; nothing was sent");
          note("failed", `${member}: [gmail_quota] Gmail rate limit reached; will retry later`, "rate_limited");
          result.failed += 1;
          result.stoppedBecause = "rate-limited";
          // Only THIS member's account is limited: the ledger row above is its cool-down (see evaluate), so its remaining e-mails wait
          // while the other members' accounts keep sending.
        } else if (out.status === "auth_failed" || out.status === "no_access") {
          const reason = out.status === "auth_failed" ? out.reason : `no Gmail access (${out.access})`;
          await patchLedger(deps, row, { status: "failed_transient", notBefore: new Date(now.getTime() + RETRY_AFTER_AUTH_MS).toISOString(), reason }, "authorisation failure; nothing was sent");
          note("failed", `${member}: [gmail_auth] ${reason}`, "auth");
          result.failed += 1;
        } else if (out.status === "not_a_draft") {
          // Gmail refused: the id is not a draft any more, so this request sent NOTHING. Ask Gmail what the message is. Never retried, never assumed.
          const seen = await deps.gmail.inspect(ctx.member, ctx.draft.gmailDraftId, row.threadId || undefined).catch((): DraftInspection => ({ state: "unknown", reason: "Gmail could not be queried" }));
          if (seen.state === "sent_outside") {
            await patchLedger(deps, row, { status: "sent_outside", reason: sentOutsideReason(seen.messageId) }, "Gmail: message not a draft and already SENT outside JobSync; nothing was sent by this system");
            await syncParked(member, rec, { kind: "stale", check: "not_already_received", sentOutside: true, reason: STALE_SENT });
            result.externallySent = (result.externallySent ?? 0) + 1;
          } else {
            const why = seen.state === "pending_draft" ? "Gmail refused the send as \"Message not a draft\" although the message is labelled DRAFT" : `Gmail refused the send as "Message not a draft" and its state could not be confirmed (${seen.reason})`;
            await patchLedger(deps, row, { status: "needs_review", reason: why.slice(0, 200) }, "not a draft; state unconfirmed; left for review, not retried");
            note("review", `${member}: [email_generated] ${why}`, "not_a_draft");
            result.needsReview += 1;
          }
        } else if (out.status === "rejected") {
          await patchLedger(deps, row, { status: "failed_permanent", reason: out.reason }, "rejected by Gmail; will not be retried");
          note("review", `${member}: [valid_email] Gmail rejected the message: ${out.reason}`, "rejected");
          result.needsReview += 1;
        } else {
          // uncertain (timeout, 5xx, unconfirmed 2xx, or "draft missing" which may mean it was already sent): reconcile NOW, never resend.
          row = (await deps.sheet.readSendLedger()).records.find((r) => r.claimId === row.claimId) ?? row;
          await patchLedger(deps, row, { status: "uncertain", reason: out.status === "uncertain" ? out.reason : "draft not found after the send request" }, "uncertain send result; reconciling");
          const verdict = await deps.gmail.reconcile(ctx.member, ctx.draft.gmailDraftId, row.threadId || undefined, attemptStartedMs).catch((): Reconciliation => ({ state: "unknown", reason: "reconcile failed" }));
          result.reconciled += 1;
          if (verdict.state === "sent") {
            await finishSent(deps, row, verdict.messageId ?? "", row.threadId || undefined, "confirmed by reconciliation");
            result.sent += 1;
          } else if (verdict.state === "external") {
            await patchLedger(deps, row, { status: "sent_outside", reason: verdict.reason }, "reconciled: sent outside JobSync before this attempt; not counted as ours");
            await syncParked(member, rec, { kind: "stale", check: "not_already_received", sentOutside: true, reason: STALE_SENT });
            result.externallySent = (result.externallySent ?? 0) + 1;
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
        // After a confirmed send the in-memory ledger already holds the updated row (it is the same object); anything else is re-read.
        if (out.status !== "sent") ledgerAll = (await deps.sheet.readSendLedger()).records;
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
  await flushParks();
  return result;
}
