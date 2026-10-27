import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { loadGmailConfig } from "@/lib/gmail/config";
import { encryptToken } from "@/lib/gmail/crypto";
import { exchangeCode, GmailAuthError, STATE_COOKIE, verifyState } from "@/lib/gmail/oauth";
import { upsertGmailAccount } from "@/lib/gmail/store";
import { SheetsError } from "@/lib/google-sheets/errors";
import { nowIso } from "@/lib/utils/time";

/**
 * Google redirects here after consent. The flow completes only if the state is genuine, unexpired, issued to
 * the member who is signed in now, and matches this browser's nonce cookie. The refresh token is encrypted
 * (bound to that member) before it is stored; it is never logged, returned or shown.
 */
export async function GET(req: NextRequest) {
  const back = (query: string) => {
    const res = NextResponse.redirect(new URL(`/gmail?${query}`, req.url));
    res.cookies.set(STATE_COOKIE, "", { httpOnly: true, path: "/api/gmail", maxAge: 0 });
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  const session = await getSession();
  if (!session) return back("error=signed_out");
  const cfg = loadGmailConfig();
  if (!cfg.ok) return back("error=not_configured");
  const params = req.nextUrl.searchParams;
  if (params.get("error")) return back("error=denied");
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return back("error=invalid_state");
  const member = await verifyState(cfg.config, state, req.cookies.get(STATE_COOKIE)?.value);
  if (!member || member !== session.memberId) return back("error=invalid_state");

  try {
    const tokens = await exchangeCode(cfg.config, code);
    const at = nowIso();
    await upsertGmailAccount({
      memberId: member, email: tokens.email, refreshTokenEnc: encryptToken(tokens.refreshToken, cfg.config.encryptionKey, member),
      scope: tokens.scope, status: "connected", connectedAt: at, updatedAt: at, lastError: "",
    });
  } catch (err) {
    if (err instanceof GmailAuthError) return back(`error=${err.code}`);
    if (err instanceof SheetsError && err.code === "schema_invalid") return back("error=not_set_up");
    console.error("[gmail] connect failed", err instanceof Error ? err.name : typeof err);
    return back("error=unavailable");
  }
  return back("connected=1");
}
