import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { MemberId } from "@/config/members";

const ENV_KEYS: Record<MemberId, string> = {
  anni: "ACCESS_CODE_ANNI",
  lukky: "ACCESS_CODE_LUKKY",
  rishii: "ACCESS_CODE_RISHII",
};

/**
 * Prototype codes, used ONLY outside production when the env var is unset.
 * They live in server code and are never sent to the browser.
 * Rotate or replace with managed secrets before production.
 */
const PROTOTYPE_CODES: Record<MemberId, string> = {
  anni: "0001",
  lukky: "0002",
  rishii: "0003",
};

function expectedCode(memberId: MemberId): string | undefined {
  const fromEnv = process.env[ENV_KEYS[memberId]];
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV !== "production") return PROTOTYPE_CODES[memberId];
  return undefined; // fail closed in production
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time comparison of a submitted code (a string) against the member's code. */
export function verifyAccessCode(memberId: MemberId, submitted: string): boolean {
  const expected = expectedCode(memberId);
  if (expected === undefined) return false;
  return timingSafeEqual(digest(submitted), digest(expected));
}
