import "server-only";

/**
 * Gmail draft access via Google OAuth 2.0 (each member authorises their own Gmail; no passwords anywhere).
 *
 *   GOOGLE_OAUTH_CLIENT_ID        OAuth client ID (Google Cloud → APIs & Services → Credentials, type "Web application")
 *   GOOGLE_OAUTH_CLIENT_SECRET    its client secret (server-only)
 *   GOOGLE_OAUTH_REDIRECT_URI     exactly one of the client's "Authorised redirect URIs",
 *                                 e.g. http://localhost:3000/api/gmail/callback (local) or
 *                                 https://jobsbyarillabs.vercel.app/api/gmail/callback (production)
 *   GMAIL_TOKEN_ENCRYPTION_KEY    32 random bytes, base64 (`openssl rand -base64 32`); encrypts stored refresh tokens
 */
export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: Buffer;
}

/** Only the scopes needed: identify the account (openid, email) and create drafts (gmail.compose). */
export const GMAIL_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.compose"] as const;
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
/**
 * Optional, for "was my draft sent?" tracking (GMAIL_TRACK_SENT=true): labels and headers, never bodies.
 * Used only to look at the thread of a draft JobSync itself created. Without it, sent/deleted cannot be
 * told apart and connection statuses are left unchanged.
 */
export const GMAIL_METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";

export function trackSentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GMAIL_TRACK_SENT === "true";
}

/** Scopes to request on the consent screen. */
export function requestedScopes(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...GMAIL_SCOPES, ...(trackSentEnabled(env) ? [GMAIL_METADATA_SCOPE] : [])];
}

export type GmailConfigResult = { ok: true; config: GmailOAuthConfig } | { ok: false; missing: string[] };

export function loadGmailConfig(env: NodeJS.ProcessEnv = process.env): GmailConfigResult {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  const rawKey = env.GMAIL_TOKEN_ENCRYPTION_KEY?.trim();
  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_OAUTH_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_OAUTH_CLIENT_SECRET");
  let redirectOk = false;
  try {
    const u = new URL(redirectUri ?? "");
    redirectOk = (u.protocol === "https:" || u.hostname === "localhost") && u.pathname === "/api/gmail/callback";
  } catch {
    redirectOk = false;
  }
  if (!redirectOk) missing.push("GOOGLE_OAUTH_REDIRECT_URI");
  const key = rawKey ? Buffer.from(rawKey, "base64") : Buffer.alloc(0);
  if (key.length !== 32) missing.push("GMAIL_TOKEN_ENCRYPTION_KEY");
  if (missing.length) return { ok: false, missing };
  return { ok: true, config: { clientId: clientId!, clientSecret: clientSecret!, redirectUri: redirectUri!, encryptionKey: key } };
}
