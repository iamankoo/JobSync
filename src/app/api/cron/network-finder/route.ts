import { createHash, timingSafeEqual } from "node:crypto";
import { errorJson, errorResponse } from "@/lib/api/responses";
import { runScheduledCycle, summarizeCycle } from "@/lib/network-finder/run";

// One company per call (public pages are read at 1 request/second per site) plus Sheets round-trips.
export const maxDuration = 60;

const digest = (v: string) => createHash("sha256").update(v).digest();

/**
 * Network Finder scheduled run, called by cron-job.org (works while every laptop is off). Protected with
 * `Authorization: Bearer $NETWORK_FINDER_CRON_SECRET`; there is no member session because it is not a member action.
 *
 *   GET /api/cron/network-finder
 *
 * Safe to call as often as every few minutes: outside the five batch windows only the sent-draft check, the
 * daily job search and job re-checks run; a second call while one is running returns "busy". Nothing it does
 * can send an email. OFF unless NETWORK_FINDER_ENABLED=true.
 */
export async function GET(req: Request) {
  const secret = process.env.NETWORK_FINDER_CRON_SECRET;
  if (!secret) return errorJson(503, "cron_disabled", "The Network Finder endpoint is not configured (NETWORK_FINDER_CRON_SECRET is not set).");
  const given = req.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) return errorJson(401, "unauthenticated", "Invalid credentials.");
  try {
    const run = await runScheduledCycle();
    if (!run.ran) return errorJson(run.reason === "busy" ? 409 : 503, run.reason ?? "disabled", run.reason === "busy" ? "A run is already in progress." : "The Network Finder is switched off (NETWORK_FINDER_ENABLED).");
    // Counts only (no names / emails in cron-job.org's history). A step that failed is listed in `errors` and simply
    // runs again next call; the status stays 200 so cron-job.org does not switch the job off after a few failures.
    return Response.json({ data: summarizeCycle(run) }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
