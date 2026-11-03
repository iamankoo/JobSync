import "server-only";
import type { MemberId } from "@/config/members";
import { createHash } from "node:crypto";
import { nowIso } from "@/lib/utils/time";
import { safeAttachmentName, type DraftAttachment } from "./attachment";
import { isEmailAddress } from "@/lib/validation/connections";
import { GMAIL_METADATA_SCOPE, loadGmailConfig } from "./config";
import { decryptToken } from "./crypto";
import { GmailAuthError, refreshAccessToken, type FetchLike } from "./oauth";
import { readGmailAccounts, updateGmailStatus } from "./store";

/**
 * Gmail access for ONE member at a time, using only that member's stored authorisation.
 * Calls made: drafts.create (new draft), drafts.get and threads.get (read-only checks). JobSync never calls
 * any send, delete, trash, modify or label endpoint — it cannot send or change anyone's mail.
 */
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const DRAFTS_ENDPOINT = `${GMAIL_API}/drafts`;

export interface DraftMessage {
  to?: string;
  subject: string;
  body: string;
  /** Optional file (a resume) attached to the DRAFT. Without it the message is the same single-part text as before. */
  attachment?: DraftAttachment;
}

const noBreaks = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const encodedWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/**
 * RFC 2822 message (plain text, UTF-8), base64url-encoded for the Gmail API. Header injection is impossible.
 * With an attachment it is multipart/mixed: the same text part, then the file as a base64 attachment.
 */
export function buildRawMessage(msg: DraftMessage): string {
  const CRLF = "\r\n";
  const headers: string[] = [];
  const to = msg.to ? noBreaks(msg.to) : "";
  if (to && isEmailAddress(to)) headers.push(`To: ${to}`);
  headers.push(`Subject: ${encodedWord(noBreaks(msg.subject))}`, "MIME-Version: 1.0");
  const wrap = (b64: string) => b64.replace(/.{76}/g, "$&" + CRLF);
  const text = wrap(Buffer.from(msg.body.replace(/\r?\n/g, CRLF), "utf8").toString("base64"));
  if (!msg.attachment) {
    headers.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
    return Buffer.from(`${headers.join(CRLF)}${CRLF}${CRLF}${text}`, "utf8").toString("base64url");
  }
  const name = safeAttachmentName(msg.attachment.fileName);
  // '_' never occurs in base64, so the boundary cannot appear inside any part.
  const boundary = `jobsync_${createHash("sha256").update(`${name}|${msg.attachment.bytes.length}|${msg.subject}`).digest("hex").slice(0, 24)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const file = wrap(Buffer.from(msg.attachment.bytes).toString("base64"));
  const parts = [
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", text,
    `--${boundary}`, `Content-Type: ${msg.attachment.mimeType}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", file,
    `--${boundary}--`, "",
  ];
  return Buffer.from(`${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}`, "utf8").toString("base64url");
}

type Access = { ok: true; token: string; scopes: string[] } | { ok: false; status: "not_authorized" | "reauth_required" | "failed"; reason?: string };

/** A fresh access token for `memberId` from THEIR stored refresh token (no other member's row is used). */
async function accessFor(memberId: MemberId, fetchFn: FetchLike): Promise<Access> {
  const cfg = loadGmailConfig();
  if (!cfg.ok) return { ok: false, status: "not_authorized" };
  const account = (await readGmailAccounts({ fresh: true })).find((a) => a.memberId === memberId);
  if (!account || account.status !== "connected" || !account.refreshTokenEnc) return { ok: false, status: "not_authorized" };
  const refreshToken = decryptToken(account.refreshTokenEnc, cfg.config.encryptionKey, memberId);
  if (!refreshToken) {
    await updateGmailStatus(memberId, "reauth_required", "stored token could not be decrypted", nowIso());
    return { ok: false, status: "reauth_required" };
  }
  try {
    return { ok: true, token: await refreshAccessToken(cfg.config, refreshToken, fetchFn), scopes: account.scope.split(/\s+/) };
  } catch (err) {
    if (err instanceof GmailAuthError && err.code === "reauth_required") {
      await updateGmailStatus(memberId, "reauth_required", "Google refused the refresh token", nowIso());
      return { ok: false, status: "reauth_required" };
    }
    return { ok: false, status: "failed", reason: "token refresh unavailable" };
  }
}

export type DraftResult =
  /** `attachment`: only when one was requested; "verified" = the saved draft was read back and holds the file. */
  | { status: "created"; draftId: string; threadId?: string; attachment?: "verified" | "unverified" }
  | { status: "not_authorized" }
  | { status: "reauth_required" }
  | { status: "failed"; reason: string };

/** Whether `memberId` has a usable Gmail connection (without touching Google). */
export async function isGmailConnected(memberId: MemberId): Promise<boolean> {
  return (await readGmailAccounts()).some((a) => a.memberId === memberId && a.status === "connected" && a.refreshTokenEnc);
}

export async function createDraftFor(memberId: MemberId, msg: DraftMessage, fetchFn: FetchLike = fetch): Promise<DraftResult> {
  const access = await accessFor(memberId, fetchFn);
  if (!access.ok) return access.status === "failed" ? { status: "failed", reason: access.reason ?? "unavailable" } : { status: access.status };
  let res: Response;
  try {
    res = await fetchFn(DRAFTS_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${access.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw: buildRawMessage(msg) } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { status: "failed", reason: "Gmail unavailable" };
  }
  if (res.status === 401 || res.status === 403) {
    await updateGmailStatus(memberId, "reauth_required", `Gmail refused draft creation (${res.status})`, nowIso());
    return { status: "reauth_required" };
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: { threadId?: string } };
  if (!res.ok || !body.id) return { status: "failed", reason: `Gmail error ${res.status}` };
  const created = { status: "created" as const, draftId: body.id, ...(body.message?.threadId ? { threadId: body.message.threadId } : {}) };
  if (!msg.attachment) return created;
  return { ...created, attachment: (await draftHasAttachment(access.token, body.id, safeAttachmentName(msg.attachment.fileName), fetchFn)) ? "verified" : "unverified" };
}

type MimePart = { filename?: string; body?: { attachmentId?: string; size?: number }; parts?: MimePart[] };

/** Reads the saved draft back (read-only) and checks the file is really in it. Any doubt = false. */
async function draftHasAttachment(token: string, draftId: string, fileName: string, fetchFn: FetchLike): Promise<boolean> {
  try {
    const res = await fetchFn(`${DRAFTS_ENDPOINT}/${encodeURIComponent(draftId)}?format=full`, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return false;
    const draft = (await res.json().catch(() => null)) as { message?: { payload?: MimePart } } | null;
    const walk = (p?: MimePart): boolean => Boolean(p) && ((p!.filename === fileName && Boolean(p!.body?.attachmentId || (p!.body?.size ?? 0) > 0)) || (p!.parts ?? []).some(walk));
    return walk(draft?.message?.payload);
  } catch {
    return false;
  }
}

/**
 * What became of a draft JobSync created, in that member's own Gmail (read-only):
 *  - "draft_exists": still a draft (not sent yet);
 *  - "sent":         the draft is gone and its thread now holds a SENT message;
 *  - "deleted":      the draft is gone and so is its thread (deleted without sending);
 *  - "unknown":      cannot tell (no metadata permission, not connected, Google unavailable) — callers change nothing.
 */
export type DraftState = "draft_exists" | "sent" | "deleted" | "unknown";

export async function checkDraftState(memberId: MemberId, draftId: string, threadId: string | undefined, fetchFn: FetchLike = fetch): Promise<DraftState> {
  const access = await accessFor(memberId, fetchFn);
  if (!access.ok) return "unknown";
  const get = async (url: string) => {
    try {
      return await fetchFn(url, { method: "GET", headers: { Authorization: `Bearer ${access.token}` }, signal: AbortSignal.timeout(15_000) });
    } catch {
      return null;
    }
  };
  const draft = await get(`${DRAFTS_ENDPOINT}/${encodeURIComponent(draftId)}?format=minimal`);
  if (!draft) return "unknown";
  if (draft.ok) return "draft_exists";
  if (draft.status !== 404) return "unknown";
  // The draft is gone. Telling "sent" from "deleted" needs the thread's labels (metadata permission).
  if (!threadId || !access.scopes.includes(GMAIL_METADATA_SCOPE)) return "unknown";
  const thread = await get(`${GMAIL_API}/threads/${encodeURIComponent(threadId)}?format=minimal`);
  if (!thread) return "unknown";
  if (thread.status === 404) return "deleted";
  if (!thread.ok) return "unknown";
  const body = (await thread.json().catch(() => null)) as { messages?: { labelIds?: string[] }[] } | null;
  if (!body || !Array.isArray(body.messages)) return "unknown";
  return body.messages.some((m) => (m.labelIds ?? []).includes("SENT") && !(m.labelIds ?? []).includes("DRAFT")) ? "sent" : "deleted";
}
