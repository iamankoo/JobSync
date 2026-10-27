import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { DEFAULT_SESSION_MAX_AGE_SECONDS, SESSION_COOKIE } from "@/config/auth";
import { MEMBER_IDS, type MemberId } from "@/config/members";

export interface Session {
  memberId: MemberId;
  expiresAt: number; // epoch seconds
}

/** The session signing key (also signs the short-lived Profile unlock token). */
export function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) return new TextEncoder().encode(secret);
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set (>= 32 chars) in production");
  }
  return new TextEncoder().encode("dev-only-insecure-session-secret-change-me!!");
}

export function sessionMaxAgeSeconds(): number {
  const n = Number(process.env.SESSION_MAX_AGE_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SESSION_MAX_AGE_SECONDS;
}

export async function createSessionToken(memberId: MemberId): Promise<string> {
  return new SignJWT({ memberId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${sessionMaxAgeSeconds()}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    const memberId = payload.memberId;
    if (typeof memberId !== "string" || !(MEMBER_IDS as readonly string[]).includes(memberId)) {
      return null;
    }
    return { memberId: memberId as MemberId, expiresAt: payload.exp ?? 0 };
  } catch {
    return null; // expired, tampered, or malformed
  }
}

/** Reads and verifies the session from the request cookies. */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: sessionMaxAgeSeconds(),
});
