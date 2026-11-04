import { createHash, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { errorJson } from "@/lib/api/responses";
import { ROUTE_MAX_DURATION_S, runOutreachInBackground } from "@/lib/outreach/background";
import { loadOutreachConfig } from "@/lib/outreach/config";

export const maxDuration = ROUTE_MAX_DURATION_S;
const digest = (v: string) => createHash("sha256").update(v).digest();

/**
 * Outreach Database import + unified drafting + gated sending cycle, called by cron-job.org like the Network Finder endpoint.
 *
 *   GET /api/cron/outreach      Authorization: Bearer $OUTREACH_CRON_SECRET
 *
 * OFF unless OUTREACH_ENABLED=true. The endpoint only authenticates and ACCEPTS the call: it answers 202 within milliseconds (the scheduler
 * gives up after 30 s) and the cycle runs as `after()` background work, which Vercel keeps alive for this route's `maxDuration`.
 * Every step is idempotent and resumable and a run lock keeps cycles from overlapping, so a call that arrives while one is still running does
 * nothing, and an interrupted run simply continues on the next call. Results (counts only) are logged as `[outreach] {...}`.
 */
export async function GET(req: Request) {
  const secret = process.env.OUTREACH_CRON_SECRET;
  if (!secret) return errorJson(503, "cron_disabled", "The outreach endpoint is not configured (OUTREACH_CRON_SECRET is not set).");
  const given = req.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) return errorJson(401, "unauthenticated", "Invalid credentials.");
  if (!loadOutreachConfig().enabled) return errorJson(503, "disabled", "Outreach is switched off (OUTREACH_ENABLED).");
  after(() => runOutreachInBackground());
  return Response.json({ data: { accepted: true } }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
