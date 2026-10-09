import { beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { resetAllRateLimits } from "@/lib/auth/rate-limit";
import { verifySessionToken } from "@/lib/auth/session";
import { LOGIN_MAX_ATTEMPTS, SESSION_COOKIE } from "@/config/auth";

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", "x-forwarded-for": "1.2.3.4", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => resetAllRateLimits());

  it("sets an HTTP-only signed session cookie for the right code", async () => {
    const res = await login(req({ memberId: "lukky", code: "0002" }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    const token = cookie.split(";")[0].split("=")[1];
    expect((await verifySessionToken(token))?.memberId).toBe("lukky");
  });

  it("rejects wrong codes with 401 and no cookie", async () => {
    const res = await login(req({ memberId: "anni", code: "0002" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("returns 400 for malformed input", async () => {
    expect((await login(req("not json"))).status).toBe(400);
    expect((await login(req({ memberId: "anni" }))).status).toBe(400);
    expect((await login(req({ memberId: "anni", code: 1 }))).status).toBe(400);
  });

  it("rejects cross-origin requests", async () => {
    const res = await login(req({ memberId: "anni", code: "0001" }, { origin: "http://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("rate limits repeated failures, even for the correct code afterwards", async () => {
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      expect((await login(req({ memberId: "rishii", code: "9999" }))).status).toBe(401);
    }
    const blocked = await login(req({ memberId: "rishii", code: "0003" }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // other member from the same IP is unaffected
    expect((await login(req({ memberId: "anni", code: "0001" }))).status).toBe(200);
  });

  it("never echoes access codes in responses", async () => {
    const res = await login(req({ memberId: "anni", code: "7777" }));
    expect(await res.text()).not.toContain("7777");
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie", async () => {
    const res = await logout(new Request("http://localhost/api/auth/logout", { method: "POST", headers: { host: "localhost" } }));
    expect(res.status).toBe(200);
    const cookie = (res.headers.get("set-cookie") ?? "").toLowerCase();
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toContain("max-age=0");
  });

  it("rejects cross-origin logout", async () => {
    const res = await logout(new Request("http://localhost/api/auth/logout", { method: "POST", headers: { host: "localhost", origin: "http://evil.example" } }));
    expect(res.status).toBe(403);
  });
});
