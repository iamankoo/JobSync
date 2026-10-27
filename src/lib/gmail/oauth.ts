import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { GMAIL_COMPOSE_SCOPE, requestedScopes, type GmailOAuthConfig } from "./config";

/**
 * Google OAuth 2.0 authorization-code flow (server side). The authorise URL carries a signed, 10-minute
 * `state` bound to the signed-in member and to a random nonce kept in an httpOnly cookie, so a callback
 * can only complete the flow that member started in that browser.
 */
export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const STATE_COOKIE = "jobsync_gmail_oauth";
const STATE_TTL_S = 600;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class GmailAuthError extends Error {
  constructor(readonly code: "reauth_required" | "denied" | "invalid_state" | "scope_missing" | "no_refresh_token" | "token_exchange_failed" | "unavailable", message: string) {
    super(message);
    this.name = "GmailAuthError";
  }
}

const stateKey = (config: GmailOAuthConfig) => createHash("sha256").update(config.encryptionKey).update("gmail-oauth-state").digest();

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

export async function signState(config: GmailOAuthConfig, memberId: MemberId, nonce: string): Promise<string> {
  return new SignJWT({ m: memberId, n: createHash("sha256").update(nonce).digest("base64url"), p: "gmail_oauth" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_S}s`)
    .sign(stateKey(config));
}

/** The member the state was issued to, if it is genuine, unexpired and matches this browser's nonce. */
export async function verifyState(config: GmailOAuthConfig, state: string, nonce: string | undefined): Promise<MemberId | null> {
  if (!nonce) return null;
  try {
    const { payload } = await jwtVerify(state, stateKey(config), { algorithms: ["HS256"] });
    const expected = Buffer.from(createHash("sha256").update(nonce).digest("base64url"));
    const got = Buffer.from(typeof payload.n === "string" ? payload.n : "");
    if (payload.p !== "gmail_oauth" || got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    return typeof payload.m === "string" && (MEMBER_IDS as readonly string[]).includes(payload.m) ? (payload.m as MemberId) : null;
  } catch {
    return null;
  }
}

export function buildAuthUrl(config: GmailOAuthConfig, state: string): string {
  const q = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: requestedScopes().join(" "),
    access_type: "offline", // a refresh token, so drafts can be created while nobody is signed in
    prompt: "consent select_account", // always return a refresh token; let the member pick the right Gmail
    include_granted_scopes: "false",
    state,
  });
  return `${AUTH_ENDPOINT}?${q.toString()}`;
}

export interface GrantedTokens {
  refreshToken: string;
  accessToken: string;
  email: string;
  scope: string;
}

/** Reads the email claim of an ID token received DIRECTLY from Google's token endpoint over TLS. */
function emailFromIdToken(idToken: string | undefined): string | null {
  const part = idToken?.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { email?: string; email_verified?: boolean };
    return claims.email && claims.email_verified !== false ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function exchangeCode(config: GmailOAuthConfig, code: string, fetchFn: FetchLike = fetch): Promise<GrantedTokens> {
  let res: Response;
  try {
    res = await fetchFn(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: "authorization_code" }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GmailAuthError("unavailable", "Google could not be reached.");
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; scope?: string; id_token?: string };
  if (!res.ok || !body.access_token) throw new GmailAuthError("token_exchange_failed", "Google did not accept the authorisation code.");
  const scopes = (body.scope ?? "").split(/\s+/);
  if (!scopes.includes(GMAIL_COMPOSE_SCOPE)) throw new GmailAuthError("scope_missing", "Permission to create Gmail drafts was not granted.");
  if (!body.refresh_token) throw new GmailAuthError("no_refresh_token", "Google did not return offline access. Remove JobSync's access in your Google Account and connect again.");
  const email = emailFromIdToken(body.id_token);
  if (!email) throw new GmailAuthError("token_exchange_failed", "Google did not return the account's email address.");
  return { refreshToken: body.refresh_token, accessToken: body.access_token, email, scope: body.scope ?? "" };
}

/** A short-lived access token from a member's refresh token. `reauth_required` if revoked or expired. */
export async function refreshAccessToken(config: GmailOAuthConfig, refreshToken: string, fetchFn: FetchLike = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GmailAuthError("unavailable", "Google could not be reached.");
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (res.ok && body.access_token) return body.access_token;
  if (body.error === "invalid_grant" || res.status === 400 || res.status === 401) throw new GmailAuthError("reauth_required", "Gmail access was revoked or expired; the member must connect again.");
  throw new GmailAuthError("unavailable", `Google token refresh failed (${res.status}).`);
}

/** Best-effort revocation at Google (disconnect). */
export async function revokeToken(token: string, fetchFn: FetchLike = fetch): Promise<void> {
  try {
    await fetchFn(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10_000) });
  } catch {
    /* the token is deleted locally anyway */
  }
}
