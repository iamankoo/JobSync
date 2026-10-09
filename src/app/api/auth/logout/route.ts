import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/config/auth";
import { isSameOrigin, jsonError } from "@/lib/auth/request";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return jsonError(403, "forbidden", "Cross-origin request rejected.");
  const res = NextResponse.json({ data: { ok: true } });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
