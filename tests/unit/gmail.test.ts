import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GMAIL_COMPOSE_SCOPE, loadGmailConfig, type GmailOAuthConfig } from "@/lib/gmail/config";
import { decryptToken, encryptToken } from "@/lib/gmail/crypto";
import { buildRawMessage } from "@/lib/gmail/drafts";
import { buildAuthUrl, exchangeCode, newNonce, refreshAccessToken, signState, verifyState, type FetchLike } from "@/lib/gmail/oauth";

/** All Google endpoints here are MOCKED: nothing contacts Google. */
const config: GmailOAuthConfig = { clientId: "test-client.apps.googleusercontent.com", clientSecret: "test-secret", redirectUri: "http://localhost:3000/api/gmail/callback", encryptionKey: randomBytes(32) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const idToken = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("Gmail config", () => {
  it("names every missing or malformed setting (values are never echoed)", () => {
    const r = loadGmailConfig({ GOOGLE_OAUTH_REDIRECT_URI: "http://evil.example/api/gmail/callback", GMAIL_TOKEN_ENCRYPTION_KEY: "short" } as unknown as NodeJS.ProcessEnv);
    expect(r).toEqual({ ok: false, missing: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI", "GMAIL_TOKEN_ENCRYPTION_KEY"] });
    const ok = loadGmailConfig({ GOOGLE_OAUTH_CLIENT_ID: "a", GOOGLE_OAUTH_CLIENT_SECRET: "b", GOOGLE_OAUTH_REDIRECT_URI: "https://jobsbyarillabs.vercel.app/api/gmail/callback", GMAIL_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") } as unknown as NodeJS.ProcessEnv);
    expect(ok.ok).toBe(true);
  });
});

describe("refresh-token encryption", () => {
  it("round-trips for the right member only; tampering or another member's row fails", () => {
    const enc = encryptToken("1//refresh-token", config.encryptionKey, "anni");
    expect(enc.startsWith("v1.")).toBe(true);
    expect(enc).not.toContain("refresh-token");
    expect(decryptToken(enc, config.encryptionKey, "anni")).toBe("1//refresh-token");
    expect(decryptToken(enc, config.encryptionKey, "lukky")).toBeNull(); // copied into Lukky's row: useless
    expect(decryptToken(enc, randomBytes(32), "anni")).toBeNull(); // wrong key
    expect(decryptToken(`${enc.slice(0, -2)}AA`, config.encryptionKey, "anni")).toBeNull(); // tampered
    expect(encryptToken("x", config.encryptionKey, "anni")).not.toBe(encryptToken("x", config.encryptionKey, "anni")); // random IV
  });
});

describe("OAuth state", () => {
  it("is bound to the member and to this browser's nonce", async () => {
    const nonce = newNonce();
    const state = await signState(config, "lukky", nonce);
    expect(await verifyState(config, state, nonce)).toBe("lukky");
    expect(await verifyState(config, state, newNonce())).toBeNull(); // another browser
    expect(await verifyState(config, state, undefined)).toBeNull(); // no cookie
    expect(await verifyState({ ...config, encryptionKey: randomBytes(32) }, state, nonce)).toBeNull(); // forged
    expect(await verifyState(config, `${state}x`, nonce)).toBeNull();
  });

  it("expires after 10 minutes", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-27T05:00:00Z") });
    try {
      const nonce = newNonce();
      const state = await signState(config, "anni", nonce);
      vi.setSystemTime(new Date("2026-10-27T05:11:00Z"));
      expect(await verifyState(config, state, nonce)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for the read-only metadata permission ONLY when sent-tracking is switched on", () => {
    vi.stubEnv("GMAIL_TRACK_SENT", "true");
    try {
      expect(new URL(buildAuthUrl(config, "S")).searchParams.get("scope")).toBe(`openid email ${GMAIL_COMPOSE_SCOPE} https://www.googleapis.com/auth/gmail.metadata`);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(new URL(buildAuthUrl(config, "S")).searchParams.get("scope")).not.toContain("gmail.metadata");
  });

  it("asks Google for offline access to drafts only (plus the account email)", () => {
    const url = new URL(buildAuthUrl(config, "STATE"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(`openid email ${GMAIL_COMPOSE_SCOPE}`);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/gmail/callback");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("scope")).not.toMatch(/gmail\.send|gmail\.readonly|gmail\.modify|mail\.google\.com/);
    expect(url.toString()).not.toContain("test-secret");
  });
});

describe("token exchange and refresh", () => {
  it("exchanges a code and reads the Gmail address from the ID token", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => json({ access_token: "ya29.a", refresh_token: "1//r", scope: `openid ${GMAIL_COMPOSE_SCOPE} email`, id_token: idToken({ email: "Anni@Gmail.com", email_verified: true }) }));
    expect(await exchangeCode(config, "CODE", fetchFn)).toEqual({ accessToken: "ya29.a", refreshToken: "1//r", email: "anni@gmail.com", scope: `openid ${GMAIL_COMPOSE_SCOPE} email` });
    const body = new URLSearchParams(String(fetchFn.mock.calls[0][1].body));
    expect(Object.fromEntries(body)).toMatchObject({ code: "CODE", grant_type: "authorization_code", redirect_uri: config.redirectUri });
  });

  it("refuses when drafts permission was unticked, or offline access was not granted", async () => {
    await expect(exchangeCode(config, "C", async () => json({ access_token: "a", refresh_token: "r", scope: "openid email", id_token: idToken({ email: "a@gmail.com" }) }))).rejects.toMatchObject({ code: "scope_missing" });
    await expect(exchangeCode(config, "C", async () => json({ access_token: "a", scope: GMAIL_COMPOSE_SCOPE, id_token: idToken({ email: "a@gmail.com" }) }))).rejects.toMatchObject({ code: "no_refresh_token" });
    await expect(exchangeCode(config, "C", async () => json({ error: "invalid_grant" }, 400))).rejects.toMatchObject({ code: "token_exchange_failed" });
  });

  it("a revoked or expired refresh token means the member must reconnect", async () => {
    expect(await refreshAccessToken(config, "1//r", async () => json({ access_token: "ya29.new" }))).toBe("ya29.new");
    await expect(refreshAccessToken(config, "1//r", async () => json({ error: "invalid_grant" }, 400))).rejects.toMatchObject({ code: "reauth_required" });
    await expect(refreshAccessToken(config, "1//r", async () => { throw new TypeError("offline"); })).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("draft message", () => {
  const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

  it("builds a plain-text UTF-8 message with an encoded subject", () => {
    const text = decode(buildRawMessage({ to: "priya@acme.example", subject: "Hello — Priya", body: "Hi Priya,\nNamaste 🙏" }));
    expect(text).toContain("To: priya@acme.example\r\n");
    expect(text).toContain(`Subject: =?UTF-8?B?${Buffer.from("Hello — Priya").toString("base64")}?=`);
    const body = text.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Hi Priya,\r\nNamaste 🙏");
  });

  it("cannot be used to inject headers or extra recipients", () => {
    const text = decode(buildRawMessage({ to: "a@b.example\r\nBcc: spy@evil.example", subject: "Hi\r\nBcc: spy@evil.example", body: "x" }));
    const headers = text.split("\r\n\r\n")[0];
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).not.toContain("To:"); // the poisoned address is rejected entirely
    expect(headers).toContain("Subject: Hi Bcc: spy@evil.example");
  });

  it("omits To when there is no valid recipient (a draft to fill in later)", () => {
    expect(decode(buildRawMessage({ subject: "S", body: "B" }))).not.toContain("To:");
  });
});
