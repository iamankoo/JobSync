import { beforeEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { DEFAULT_SESSION_MAX_AGE_SECONDS, SESSION_COOKIE } from "@/config/auth";
import { resetAllRateLimits } from "@/lib/auth/rate-limit";
import { sessionMaxAgeSeconds, verifySessionToken } from "@/lib/auth/session";

const DAY = 24 * 60 * 60;

async function loginCookie(memberId: string, code: string) {
  const res = await login(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ memberId, code }),
    }),
  );
  return (res.headers.get("set-cookie") ?? "");
}

describe("persistent login", () => {
  beforeEach(() => resetAllRateLimits());

  it("issues a persistent (Max-Age) cookie of about 30 days that survives a browser restart", async () => {
    const cookie = await loginCookie("anni", "0001");
    const maxAge = Number(/max-age=(\d+)/i.exec(cookie)?.[1]);
    expect(maxAge).toBe(DEFAULT_SESSION_MAX_AGE_SECONDS);
    expect(maxAge).toBeGreaterThanOrEqual(7 * DAY);
    expect(maxAge).toBeLessThanOrEqual(90 * DAY);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie.toLowerCase()).toContain("path=/");
  });

  it("keeps the server-side token valid for the full cookie lifetime, and no longer", async () => {
    const cookie = await loginCookie("rishii", "0003");
    const token = cookie.split(";")[0].split("=")[1];
    const session = await verifySessionToken(token);
    const remaining = (session?.expiresAt ?? 0) - Math.floor(Date.now() / 1000);
    expect(session?.memberId).toBe("rishii");
    expect(remaining).toBeGreaterThan(sessionMaxAgeSeconds() - 60);
    expect(remaining).toBeLessThanOrEqual(sessionMaxAgeSeconds());
  });

  it("does not let one member's session be turned into another's", async () => {
    const token = (await loginCookie("anni", "0001")).split(";")[0].split("=")[1];
    expect((await verifySessionToken(token))?.memberId).toBe("anni");
    const [h, , sig] = token.split(".");
    const swapped = Buffer.from(JSON.stringify({ memberId: "lukky", exp: Math.floor(Date.now() / 1000) + DAY })).toString("base64url");
    expect(await verifySessionToken(`${h}.${swapped}.${sig}`)).toBeNull();
  });

  it("still rejects an expired token", async () => {
    const key = new TextEncoder().encode("dev-only-insecure-session-secret-change-me!!");
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ memberId: "anni" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now - 40 * DAY)
      .setExpirationTime(now - 10 * DAY)
      .sign(key);
    expect(await verifySessionToken(expired)).toBeNull();
  });

  it("logout expires the cookie immediately", async () => {
    const res = await logout(new Request("http://localhost/api/auth/logout", { method: "POST", headers: { host: "localhost" } }));
    const cookie = (res.headers.get("set-cookie") ?? "").toLowerCase();
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toContain("max-age=0");
  });
});
