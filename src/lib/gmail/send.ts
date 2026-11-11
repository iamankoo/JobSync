import "server-only";
import type { MemberId } from "@/config/members";
import { nowIso } from "@/lib/utils/time";
import { GMAIL_METADATA_SCOPE } from "./config";
import { accessFor, DRAFTS_ENDPOINT, GMAIL_API } from "./drafts";
import type { FetchLike } from "./oauth";
import { updateGmailStatus } from "./store";

/**
 * The ONLY code that can send mail: it sends an already-created, already-verified DRAFT from the member's own mailbox
 * (drafts.send, covered by the gmail.compose permission members already granted; no new scope).
 *
 * It is only ever called by the outreach send workflow, which refuses to run while SENDING_ENABLED (a compile-time constant,
 * default false) is off. Every call is classified so the caller can tell apart:
 *   sent         Gmail confirmed: a message id and the SENT label.
 *   definitely NOT sent: rate limited, authorisation failed, rejected as invalid.
 *   uncertain    the request may have reached Gmail (timeout, network error, 5xx, 2xx without confirmation). NEVER retried
 *                blindly: the caller must reconcile first (see reconcileDraftSend).
 */
export const SEND_ENDPOINT = `${DRAFTS_ENDPOINT}/send`;

export type SendOutcome =
  | { status: "sent"; messageId: string; threadId?: string }
  | { status: "auth_failed"; reason: string }
  | { status: "rate_limited"; retryAfterMs?: number }
  | { status: "rejected"; reason: string }
  /**
   * Gmail's specific refusal "Message not a draft": the id no longer names a draft (the message was already sent or otherwise left the Drafts folder
   * outside JobSync). Nothing was sent by this request. Distinct from a generic 400 so the caller can look at Gmail's real state instead of
   * recording a permanent failure.
   */
  | { status: "not_a_draft" }
  | { status: "draft_missing" }
  | { status: "uncertain"; reason: string };

const NOT_A_DRAFT = /not a draft/i;
const RATE_REASONS = /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quotaExceeded|sendingLimitExceeded/i;

/** Pure: maps a Gmail drafts.send HTTP response to an outcome. Exported for tests. */
export function classifySendResponse(status: number, body: unknown, retryAfter?: string | null): SendOutcome {
  const b = (body ?? {}) as { id?: string; threadId?: string; labelIds?: string[]; error?: { errors?: { reason?: string }[]; status?: string; message?: string } };
  const reasons = (b.error?.errors ?? []).map((e) => e.reason ?? "").join(",") + " " + (b.error?.status ?? "");
  if (status >= 200 && status < 300) {
    // Confirmed only with a message id AND the SENT label; anything less is not proof of a send.
    return b.id && (b.labelIds ?? []).includes("SENT") ? { status: "sent", messageId: b.id, ...(b.threadId ? { threadId: b.threadId } : {}) } : { status: "uncertain", reason: "2xx response without a SENT message id" };
  }
  if (status === 429 || (status === 403 && RATE_REASONS.test(reasons))) {
    const secs = Number(retryAfter);
    return { status: "rate_limited", ...(Number.isFinite(secs) && secs > 0 ? { retryAfterMs: secs * 1000 } : {}) };
  }
  if (status === 401 || status === 403) return { status: "auth_failed", reason: `Gmail refused the request (${status})` };
  if (status === 404) return { status: "draft_missing" };
  if (status === 400 && NOT_A_DRAFT.test(b.error?.message ?? "")) return { status: "not_a_draft" };
  if (status === 400 || status === 422) return { status: "rejected", reason: (b.error?.message ?? "invalid request").slice(0, 160) };
  return { status: "uncertain", reason: `Gmail answered ${status}` };
}

export async function sendDraftFor(memberId: MemberId, draftId: string, fetchFn: FetchLike = fetch): Promise<SendOutcome | { status: "no_access"; access: "not_authorized" | "reauth_required" | "failed" }> {
  const access = await accessFor(memberId, fetchFn);
  if (!access.ok) return { status: "no_access", access: access.status };
  let res: Response;
  try {
    res = await fetchFn(SEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: draftId }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    // The request may or may not have been processed: uncertain, never "failed".
    return { status: "uncertain", reason: "no response from Gmail (timeout or network error)" };
  }
  const body = await res.json().catch(() => ({}));
  const outcome = classifySendResponse(res.status, body, res.headers.get("retry-after"));
  if (outcome.status === "auth_failed") await updateGmailStatus(memberId, "reauth_required", `Gmail refused sending (${res.status})`, nowIso());
  return outcome;
}

export interface DraftReadback {
  to: string;
  from: string;
  subject: string;
  /** The plain-text body as saved in Gmail. */
  body: string;
  attachments: { filename: string; size: number }[];
  threadId?: string;
  /**
   * The Gmail labels of the saved message, exactly as Gmail reported them. A message that can still be sent has DRAFT and not SENT. `undefined` means
   * Gmail did not report labels: that is NOT proof of a draft, so the sender does not send on it.
   */
  labelIds?: string[];
}

type Part = { mimeType?: string; filename?: string; body?: { attachmentId?: string; size?: number; data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] };

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** Pure: extracts what the sender must check from a drafts.get?format=full response. Exported for tests. */
export function parseDraftReadback(json: unknown): DraftReadback | null {
  const msg = (json as { message?: { threadId?: string; labelIds?: unknown; payload?: Part } } | null)?.message;
  const payload = msg?.payload;
  if (!payload) return null;
  const header = (n: string) => payload.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
  const attachments: DraftReadback["attachments"] = [];
  let body = "";
  const walk = (p: Part) => {
    if (p.filename) attachments.push({ filename: p.filename, size: p.body?.size ?? 0 });
    else if (p.mimeType === "text/plain" && p.body?.data && !body) body = b64(p.body.data);
    (p.parts ?? []).forEach(walk);
  };
  walk(payload);
  const labelIds = Array.isArray(msg?.labelIds) ? (msg.labelIds as unknown[]).filter((l): l is string => typeof l === "string") : undefined;
  return { to: header("to"), from: header("from"), subject: header("subject"), body: body.replace(/\r\n/g, "\n"), attachments, ...(msg?.threadId ? { threadId: msg.threadId } : {}), ...(labelIds ? { labelIds } : {}) };
}

export type ReadResult = { status: "ok"; draft: DraftReadback } | { status: "not_found" } | { status: "no_access"; access: "not_authorized" | "reauth_required" | "failed" } | { status: "error"; reason: string };

/** Reads the saved draft back (read-only) so the sender checks the REAL message, not what it intended to create. */
export async function readDraftFor(memberId: MemberId, draftId: string, fetchFn: FetchLike = fetch): Promise<ReadResult> {
  const access = await accessFor(memberId, fetchFn);
  if (!access.ok) return { status: "no_access", access: access.status };
  try {
    const res = await fetchFn(`${DRAFTS_ENDPOINT}/${encodeURIComponent(draftId)}?format=full`, { method: "GET", headers: { Authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return { status: "not_found" };
    if (res.status === 401 || res.status === 403) return { status: "no_access", access: "reauth_required" };
    if (!res.ok) return { status: "error", reason: `Gmail error ${res.status}` };
    const parsed = parseDraftReadback(await res.json().catch(() => null));
    return parsed ? { status: "ok", draft: parsed } : { status: "error", reason: "unreadable draft" };
  } catch {
    return { status: "error", reason: "Gmail unavailable" };
  }
}

export type Reconciliation =
  | { state: "sent"; messageId?: string }
  /** The draft still exists (Gmail labels it DRAFT): the send did not happen, so it is safe to send again. */
  | { state: "not_sent" }
  /**
   * The message is SENT, but it was sent BEFORE this send attempt began (or Gmail refused the attempt): somebody sent it outside JobSync. Nothing
   * this system did produced it, so it is never counted as an automated send.
   */
  | { state: "external"; reason: string }
  /** Nothing proves what happened (deleted by the member, no permission to look, Gmail unreadable, no labels reported). Never treated as sent OR not sent. */
  | { state: "unknown"; reason: string };

/** What Gmail itself says about one draft id right now (read-only). */
type DraftState =
  | { kind: "draft" }
  | { kind: "sent"; messageId: string; at?: number }
  | { kind: "unknown"; reason: string };

/** Reads Gmail's own state of a draft: drafts.get (labels), and for a vanished draft the labels of its thread (needs the metadata permission). */
async function lookupDraftState(memberId: MemberId, draftId: string, threadId: string | undefined, fetchFn: FetchLike): Promise<DraftState> {
  const access = await accessFor(memberId, fetchFn);
  if (!access.ok) return { kind: "unknown", reason: "Gmail access unavailable" };
  const get = async (url: string) => {
    try {
      return await fetchFn(url, { method: "GET", headers: { Authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(15_000) });
    } catch {
      return null;
    }
  };
  const draft = await get(`${DRAFTS_ENDPOINT}/${encodeURIComponent(draftId)}?format=minimal`);
  if (!draft) return { kind: "unknown", reason: "Gmail unavailable" };
  if (draft.ok) {
    // Gmail still resolves the id of a draft that has been SENT: the labels of the message behind it are the authority, not the HTTP status.
    const body = (await draft.json().catch(() => null)) as { message?: { id?: string; labelIds?: unknown; internalDate?: string } } | null;
    const labels = Array.isArray(body?.message?.labelIds) ? (body!.message!.labelIds as unknown[]).filter((l): l is string => typeof l === "string") : null;
    if (!labels) return { kind: "unknown", reason: "Gmail did not report the labels of the draft's message" };
    if (labels.includes("DRAFT") && !labels.includes("SENT")) return { kind: "draft" };
    if (labels.includes("SENT")) {
      const at = Number(body?.message?.internalDate);
      return body?.message?.id ? { kind: "sent", messageId: body.message.id, ...(Number.isFinite(at) && at > 0 ? { at } : {}) } : { kind: "unknown", reason: "the message is SENT but Gmail gave no message id" };
    }
    return { kind: "unknown", reason: `the message is no longer a draft (labels: ${labels.join(",") || "none"})` };
  }
  if (draft.status !== 404) return { kind: "unknown", reason: `Gmail answered ${draft.status}` };
  if (!threadId || !access.scopes.includes(GMAIL_METADATA_SCOPE)) return { kind: "unknown", reason: "draft is gone and the thread cannot be checked (metadata permission missing)" };
  const thread = await get(`${GMAIL_API}/threads/${encodeURIComponent(threadId)}?format=minimal`);
  if (!thread || !thread.ok) return { kind: "unknown", reason: "thread could not be read" };
  const body = (await thread.json().catch(() => null)) as { messages?: { id?: string; labelIds?: string[]; internalDate?: string }[] } | null;
  const sentAll = (body?.messages ?? []).filter((m) => m.id && (m.labelIds ?? []).includes("SENT") && !(m.labelIds ?? []).includes("DRAFT"));
  // A reconciled send is recorded only with Gmail's own message id; a SENT message without one is not proof enough.
  if (!sentAll.length) return { kind: "unknown", reason: "draft is gone and its thread shows no identifiable sent message" };
  // The LATEST sent message: if the attempt produced one it is the newest, and an older sent message must never be mistaken for it.
  const dated = sentAll.map((m) => ({ id: m.id as string, at: Number(m.internalDate) })).map((m) => ({ id: m.id, ...(Number.isFinite(m.at) && m.at > 0 ? { at: m.at } : {}) }));
  const latest = dated.reduce((a, b) => ((b.at ?? 0) > (a.at ?? 0) ? b : a));
  return { kind: "sent", messageId: latest.id, ...(latest.at !== undefined ? { at: latest.at } : {}) };
}

/**
 * After an uncertain send: asks Gmail what happened to the draft. Labelled DRAFT => the send did not happen. A SENT message is attributed to THIS attempt
 * only when Gmail's own timestamp for it is at or after `sinceMs`, the moment the attempt's Gmail request began; an older one was sent outside JobSync
 * ("external", never counted as ours). If the attempt's start or the message's time is unknown, a SENT message is NOT attributed to anyone ("unknown"):
 * a pre-existing SENT message can therefore never become a JobSync send. Anything unproven => "unknown", which the workflow turns into a manual-review
 * flag; it is never treated as "not sent" and never as "sent".
 */
export async function reconcileDraftSend(memberId: MemberId, draftId: string, threadId: string | undefined, fetchFn: FetchLike = fetch, sinceMs?: number): Promise<Reconciliation> {
  const s = await lookupDraftState(memberId, draftId, threadId, fetchFn);
  if (s.kind === "draft") return { state: "not_sent" };
  if (s.kind === "unknown") return { state: "unknown", reason: s.reason };
  if (sinceMs === undefined || s.at === undefined) return { state: "unknown", reason: "a SENT message exists but cannot be shown to come from this attempt (the attempt's start or the message's time is unknown)" };
  // Strictly earlier than the request = sent before it. The request began after `sinceMs` was taken, so this attempt's own message is never earlier.
  if (s.at < sinceMs) return { state: "external", reason: "the message was sent before this attempt began, so it was sent outside JobSync" };
  return { state: "sent", messageId: s.messageId };
}

export type DraftInspection =
  | { state: "pending_draft" }
  | { state: "sent_outside"; messageId: string }
  | { state: "unknown"; reason: string };

/**
 * Used after Gmail answered "Message not a draft": this system's request sent NOTHING, so a SENT message behind the id was necessarily sent outside
 * JobSync. Read-only. If Gmail cannot be queried reliably the answer is "unknown": never assumed sent, never assumed deleted.
 */
export async function inspectDraftFor(memberId: MemberId, draftId: string, threadId: string | undefined, fetchFn: FetchLike = fetch): Promise<DraftInspection> {
  const s = await lookupDraftState(memberId, draftId, threadId, fetchFn);
  if (s.kind === "draft") return { state: "pending_draft" };
  if (s.kind === "sent") return { state: "sent_outside", messageId: s.messageId };
  return { state: "unknown", reason: s.reason };
}
