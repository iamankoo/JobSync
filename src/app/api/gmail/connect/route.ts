import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { loadGmailConfig } from "@/lib/gmail/config";
import { buildAuthUrl, newNonce, signState, STATE_COOKIE } from "@/lib/gmail/oauth";
import { isMemberActive } from "@/lib/google-sheets/members-service";

/**
 * Starts "Connect Gmail" for the SIGNED-IN member only: redirects to Google's consent screen with a signed,
 * short-lived state bound to this member and to a nonce cookie in this browser.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/login", req.url));
  try {
    if (!(await isMemberActive(session.memberId))) return NextResponse.redirect(new URL("/gmail?error=member_inactive", req.url));
  } catch {
    return NextResponse.redirect(new URL("/gmail?error=unavailable", req.url));
  }
  const cfg = loadGmailConfig();
  if (!cfg.ok) return NextResponse.redirect(new URL("/gmail?error=not_configured", req.url));
  const nonce = newNonce();
  const res = NextResponse.redirect(buildAuthUrl(cfg.config, await signState(cfg.config, session.memberId, nonce)));
  res.cookies.set(STATE_COOKIE, nonce, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/gmail", maxAge: 600 });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
