import "server-only";
import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { ApiError } from "@/lib/api/responses";
import { hashSecret, verifySecret } from "@/lib/auth/password";
import { checkRateLimit, recordFailure, resetFailures } from "@/lib/auth/rate-limit";
import { secretKey } from "@/lib/auth/session";
import { getSheetsClient } from "@/lib/google-sheets/client";
import { DomainError } from "@/lib/google-sheets/errors";
import { withWriteLock } from "@/lib/google-sheets/lock";
import { columnLetter, TABS } from "@/lib/google-sheets/schema";
import { invalidateTableCache, readTable } from "@/lib/google-sheets/table";

/**
 * Profile Lock. Each member's Profile Password is a salted scrypt hash in Members column K (never plaintext).
 * Opening the Profile always asks for it; a correct answer gives a short-lived signed cookie that is bound to the
 * CURRENT hash, so when the admin resets a password every existing unlock stops working at once.
 *
 * Anni is the administrator: he can reset any member's password (never see it), and he alone has the
 * "Another way to unlock" recovery question. Its answer is checked here against a hash only.
 */
export const ADMIN: MemberId = "anni";
export const UNLOCK_COOKIE = "jobsync_profile_unlock";
export const UNLOCK_TTL_SECONDS = 15 * 60;
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 128;

const HASH_COL = TABS.members.headers.length + 7; // K
const RECOVERY_COL = HASH_COL + 1; // L
/**
 * scrypt hash of the normalised recovery answer (trimmed, lower-case), from the server-only environment variable
 * PROFILE_RECOVERY_ANSWER_HASH. Neither the answer nor its hash is in the code. Without it the option is unavailable.
 */
const recoveryAnswerHash = () => process.env.PROFILE_RECOVERY_ANSWER_HASH?.trim() ?? "";
const RECOVERY_MAX_FAILURES = 5;
const RECOVERY_LOCK_MS = 60 * 60 * 1000;

async function locate(memberId: MemberId) {
  const hit = (await readTable("members", { fresh: true })).find((r) => r.cells[0]?.trim() === memberId);
  if (!hit) throw new DomainError("member_inactive", "This member is not in the Members tab.");
  return { row: hit.row, hash: (hit.cells[HASH_COL - 1] ?? "").trim(), recovery: (hit.cells[RECOVERY_COL - 1] ?? "").trim() };
}

async function writeCell(row: number, col: number, value: string) {
  const cell = `${TABS.members.name}!${columnLetter(col)}${row}:${columnLetter(col)}${row}`;
  try {
    await getSheetsClient().updateValues(cell, [[value]]);
  } finally {
    invalidateTableCache();
  }
}

export async function hasPassword(memberId: MemberId): Promise<boolean> {
  return Boolean((await locate(memberId)).hash);
}

const fingerprint = (hash: string) => createHash("sha256").update(hash || "none").digest("base64url").slice(0, 22);

// ---- unlock token -----------------------------------------------------------------------------------------

async function unlockToken(memberId: MemberId, hash: string): Promise<string> {
  return new SignJWT({ memberId, fp: fingerprint(hash), purpose: "profile-unlock" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${UNLOCK_TTL_SECONDS}s`)
    .sign(secretKey());
}

export function unlockCookie(token: string) {
  return { name: UNLOCK_COOKIE, value: token, httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, path: "/", maxAge: UNLOCK_TTL_SECONDS };
}

const cookieValue = (req: Request, name: string) =>
  (req.headers.get("cookie") ?? "").split(/;\s*/).map((p) => p.split("=")).find(([k]) => k === name)?.slice(1).join("=");

/** Throws 403 unless the request carries a valid unlock for THIS member and their current password. */
export async function requireProfileUnlock(req: Request, memberId: MemberId): Promise<void> {
  const token = cookieValue(req, UNLOCK_COOKIE);
  const locked = new ApiError(403, "profile_locked", "Unlock your Profile first.");
  if (!token) throw locked;
  let payload: { memberId?: unknown; fp?: unknown; purpose?: unknown };
  try {
    ({ payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] }));
  } catch {
    throw locked;
  }
  if (payload.purpose !== "profile-unlock" || payload.memberId !== memberId) throw locked;
  if (payload.fp !== fingerprint((await locate(memberId)).hash)) throw locked;
}

// ---- set / unlock / reset ---------------------------------------------------------------------------------

/** First-time setup only. Mismatched confirmation never writes anything. Returns the unlock token. */
export async function setPassword(memberId: MemberId, password: string, confirm: string): Promise<string> {
  if (password !== confirm) throw new ApiError(400, "password_mismatch", "Passwords do not match. Please try again.");
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) throw new ApiError(400, "password_invalid", `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
  return withWriteLock(async () => {
    const { row, hash: existing } = await locate(memberId);
    if (existing) throw new ApiError(409, "password_exists", "A Profile Password is already set.");
    const hash = await hashSecret(password);
    await writeCell(row, HASH_COL, hash);
    return unlockToken(memberId, hash);
  });
}

/** Checks the password (rate-limited per member). Returns the unlock token, or throws "Incorrect password." */
export async function unlockWithPassword(memberId: MemberId, password: string): Promise<string> {
  const key = `profile-pw:${memberId}`;
  const limit = checkRateLimit(key);
  if (!limit.allowed) throw new ApiError(429, "too_many_attempts", "Too many attempts. Please wait and try again.", { retryAfterSeconds: limit.retryAfterSeconds });
  const { hash } = await locate(memberId);
  if (!hash) throw new ApiError(409, "password_not_set", "Set your Profile Password first.");
  if (!(await verifySecret(password, hash))) {
    recordFailure(key);
    throw new ApiError(401, "incorrect_password", "Incorrect password.");
  }
  resetFailures(key);
  return unlockToken(memberId, hash);
}

/** Admin only (the caller must be Anni with an unlocked Profile — checked by the route). Never reveals anything. */
export async function resetPassword(target: string): Promise<{ memberId: MemberId }> {
  if (!(MEMBER_IDS as readonly string[]).includes(target)) throw new ApiError(400, "invalid_member", "Unknown member.");
  return withWriteLock(async () => {
    const { row } = await locate(target as MemberId);
    await writeCell(row, HASH_COL, "");
    resetFailures(`profile-pw:${target}`);
    return { memberId: target as MemberId };
  });
}

// ---- Anni's recovery question -----------------------------------------------------------------------------

/**
 * "Another way to unlock" (Anni only). Failed answers are counted in the sheet (so every server instance
 * shares the count): after 5 wrong answers it is locked for an hour.
 */
export async function unlockWithRecovery(memberId: MemberId, answer: string, now = Date.now()): Promise<string> {
  if (memberId !== ADMIN) throw new ApiError(403, "forbidden", "This option is not available.");
  const answerHash = recoveryAnswerHash();
  if (!answerHash.startsWith("scrypt1$")) throw new ApiError(503, "recovery_unavailable", "This option is not set up yet.");
  return withWriteLock(async () => {
    const { row, hash, recovery } = await locate(memberId);
    const [countRaw, sinceRaw] = recovery.split("|");
    let count = Number(countRaw) || 0;
    const since = Number(sinceRaw) || 0;
    if (since && now - since >= RECOVERY_LOCK_MS) count = 0;
    if (count >= RECOVERY_MAX_FAILURES) {
      throw new ApiError(429, "too_many_attempts", "Too many attempts. Please wait and try again.", { retryAfterSeconds: Math.ceil((since + RECOVERY_LOCK_MS - now) / 1000) });
    }
    if (!(await verifySecret(answer.trim().toLowerCase(), answerHash))) {
      await writeCell(row, RECOVERY_COL, `${count + 1}|${count === 0 ? now : since}`);
      throw new ApiError(401, "incorrect_answer", "That answer is not correct.");
    }
    if (recovery) await writeCell(row, RECOVERY_COL, "");
    return unlockToken(memberId, hash);
  });
}
