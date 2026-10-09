import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/config/auth";
import { verifyAccessCode } from "@/lib/auth/codes";
import { checkRateLimit, recordFailure, resetFailures } from "@/lib/auth/rate-limit";
import { clientIp, isSameOrigin, jsonError } from "@/lib/auth/request";
import { createSessionToken, sessionCookieOptions } from "@/lib/auth/session";
import { loginSchema } from "@/lib/validation/auth";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return jsonError(403, "forbidden", "Cross-origin request rejected.");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_request", "Request body must be JSON.");
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request", "Select a member and enter an access code.");

  const { memberId, code } = parsed.data;
  const key = `${clientIp(req)}:${memberId}`;

  const limit = checkRateLimit(key);
  if (!limit.allowed) {
    return jsonError(429, "rate_limited", "Too many attempts. Please try again later.", {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  }

  if (!verifyAccessCode(memberId, code)) {
    recordFailure(key);
    console.warn(`[auth] failed login member=${memberId}`);
    return jsonError(401, "invalid_code", "Incorrect access code.");
  }

  resetFailures(key);
  const res = NextResponse.json({ data: { memberId } });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(memberId), sessionCookieOptions());
  return res;
}
