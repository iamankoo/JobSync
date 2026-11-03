import { createHash, timingSafeEqual } from "node:crypto";
import { errorJson, errorResponse } from "@/lib/api/responses";
import { withHardDeadline } from "@/lib/network-finder/run";
import { loadOutreachConfig } from "@/lib/outreach/config";
import { buildRealCycleDeps, runOutreachCycle, summarizeCycle } from "@/lib/outreach/run";

export const maxDuration = 60;
const HARD_STOP_MS = 55_000;
const digest = (v: string) => createHash("sha256").update(v).digest();

/**
 * Outreach Database import + unified drafting cycle, called by cron-job.org like the Network Finder endpoint.
 *
 *   GET /api/cron/outreach      Authorization: Bearer $OUTREACH_CRON_SECRET
 *
 * OFF unless OUTREACH_ENABLED=true. Idempotent: safe to call every few minutes and to retry after a timeout. Imports at most
 * OUTREACH_DAILY_LIMIT (200) contacts per local day, a few per call. It creates Gmail DRAFTS through the existing worker and
 * can never send email. The response carries counts only.
 */
export async function GET(req: Request) {
  const secret = process.env.OUTREACH_CRON_SECRET;
  if (!secret) return errorJson(503, "cron_disabled", "The outreach endpoint is not configured (OUTREACH_CRON_SECRET is not set).");
  const given = req.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) return errorJson(401, "unauthenticated", "Invalid credentials.");
  if (!loadOutreachConfig().enabled) return errorJson(503, "disabled", "Outreach is switched off (OUTREACH_ENABLED).");
  try {
    const run = await withHardDeadline(runOutreachCycle(buildRealCycleDeps()), HARD_STOP_MS);
    if (run === "timed-out") return Response.json({ data: { ran: true, timedOut: true } }, { status: 200, headers: { "Cache-Control": "no-store" } });
    if (!run.ran) return errorJson(run.reason === "busy" ? 409 : 503, run.reason ?? "disabled", run.reason === "busy" ? "A run is already in progress." : "Outreach is switched off (OUTREACH_ENABLED).");
    const summary = summarizeCycle(run);
    // Structured, personal-data-free log line: counts and statuses only (no names, e-mail addresses, companies, tokens or message text).
    console.log(`[outreach] ${JSON.stringify({ import: summary.import && { imported: summary.import.importedThisRun, today: summary.import.importedToday, stop: summary.import.stoppedBecause }, send: summary.send && { status: summary.send.status, sent: summary.send.sent, review: summary.send.needsReview, failed: summary.send.failed, waiting: summary.send.waiting, stop: summary.send.stoppedBecause }, errors: summary.errors.length })}`);
    return Response.json({ data: summary }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
