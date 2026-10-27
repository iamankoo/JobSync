import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { verifyAccessCode } from "@/lib/auth/codes";
import { createSessionToken, verifySessionToken } from "@/lib/auth/session";
import { checkRateLimit, recordFailure, resetAllRateLimits, resetFailures } from "@/lib/auth/rate-limit";
import { loginSchema } from "@/lib/validation/auth";
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS } from "@/config/auth";
import { NAV_ITEMS } from "@/config/nav";
import { MEMBERS } from "@/config/members";

describe("access codes", () => {
  it("accepts the correct code per member and preserves leading zeros", () => {
    expect(verifyAccessCode("anni", "0001")).toBe(true);
    expect(verifyAccessCode("lukky", "0002")).toBe(true);
    expect(verifyAccessCode("rishii", "0003")).toBe(true);
    expect(verifyAccessCode("anni", "1")).toBe(false);
  });

  it("rejects another member's code and wrong codes", () => {
    expect(verifyAccessCode("anni", "0002")).toBe(false);
    expect(verifyAccessCode("rishii", "9999")).toBe(false);
    expect(verifyAccessCode("lukky", "")).toBe(false);
  });

  it("fails closed in production when no code is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(verifyAccessCode("anni", "0001")).toBe(false);
    vi.stubEnv("ACCESS_CODE_ANNI", "4242");
    expect(verifyAccessCode("anni", "4242")).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe("sessions", () => {
  it("round-trips a member session", async () => {
    const token = await createSessionToken("lukky");
    expect((await verifySessionToken(token))?.memberId).toBe("lukky");
  });

  it("rejects missing, tampered and malformed tokens", async () => {
    const token = await createSessionToken("anni");
    expect(await verifySessionToken(undefined)).toBeNull();
    expect(await verifySessionToken("garbage")).toBeNull();
    expect(await verifySessionToken(token.slice(0, -2) + "xx")).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const key = new TextEncoder().encode("dev-only-insecure-session-secret-change-me!!");
    const expired = await new SignJWT({ memberId: "anni" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 100)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(key);
    expect(await verifySessionToken(expired)).toBeNull();
  });

  it("rejects tokens signed with another secret or naming an unknown member", async () => {
    const other = new TextEncoder().encode("a-completely-different-secret-value-0123456789");
    const forged = await new SignJWT({ memberId: "anni" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(other);
    expect(await verifySessionToken(forged)).toBeNull();
    const key = new TextEncoder().encode("dev-only-insecure-session-secret-change-me!!");
    const unknown = await new SignJWT({ memberId: "mallory" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(key);
    expect(await verifySessionToken(unknown)).toBeNull();
  });
});

describe("rate limiting", () => {
  beforeEach(() => resetAllRateLimits());

  it("blocks after the maximum failures and reports retry time", () => {
    const now = 1_000_000;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      expect(checkRateLimit("k", now).allowed).toBe(true);
      recordFailure("k", now);
    }
    const blocked = checkRateLimit("k", now + 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("allows again after the window and after a reset; keys are independent", () => {
    const now = 5_000_000;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) recordFailure("a", now);
    expect(checkRateLimit("b", now).allowed).toBe(true);
    expect(checkRateLimit("a", now + LOGIN_WINDOW_MS).allowed).toBe(true);
    resetFailures("a");
    expect(checkRateLimit("a", now).allowed).toBe(true);
  });
});

describe("validation and config", () => {
  it("keeps the code as a string", () => {
    expect(loginSchema.parse({ memberId: "anni", code: "0001" }).code).toBe("0001");
    expect(loginSchema.safeParse({ memberId: "anni", code: 1 }).success).toBe(false);
    expect(loginSchema.safeParse({ memberId: "bob", code: "0001" }).success).toBe(false);
    expect(loginSchema.safeParse({ memberId: "anni", code: "" }).success).toBe(false);
  });

  it("has the five original navigation items followed by Connections and Group Chat", () => {
    expect(NAV_ITEMS.map((n) => n.label)).toEqual(["Dashboard", "All Jobs", "Add Job", "My Applications", "Analytics", "Connections", "Group Chat", "Gmail Drafts"]);
  });

  it("defines the three members with distinct accents", () => {
    expect(MEMBERS.map((m) => m.name)).toEqual(["Anni", "Lukky", "Rishii"]);
    expect(new Set(MEMBERS.map((m) => m.accent)).size).toBe(3);
  });
});
