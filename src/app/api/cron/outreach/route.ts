import { createHash, timingSafeEqual } from "node:crypto";
import { errorJson } from "@/lib/api/responses";
import { loadOutreachConfig } from "@/lib/outreach/config";
import { dispatchOutreachRunner } from "@/lib/outreach/dispatch";

const digest = (v: string) => createHash("sha256").update(v).digest();

/**
 * Outreach Database import + unified drafting + gated sending, triggered by cron-job.org like the Network Finder endpoint.
 *
 *   GET /api/cron/outreach      Authorization: Bearer $OUTREACH_CRON_SECRET
 *
 * OFF unless OUTREACH_ENABLED=true. The endpoint only authenticates and HANDS OVER: the cycles run in the Netlify Background Function
 * `outreach-background` (up to 15 minutes), never inside this request and never in `after()`. The background function takes the runner lock
 * itself, atomically, as its first step; a call that arrives while a runner is alive hands over a second invocation that finds the lock held and
 * exits at once, so repeated cron calls are harmless. Every cycle step is idempotent and resumable (write-ahead claims, send ledger, run lock).
 * Cycle results (counts only) are logged by the function as `[outreach] {...}`.
 */
export async function GET(req: Request) {
  const secret = process.env.OUTREACH_CRON_SECRET;
  if (!secret) return errorJson(503, "cron_disabled", "The outreach endpoint is not configured (OUTREACH_CRON_SECRET is not set).");
  const given = req.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) return errorJson(401, "unauthenticated", "Invalid credentials.");
  if (!loadOutreachConfig().enabled) return errorJson(503, "disabled", "Outreach is switched off (OUTREACH_ENABLED).");
  const handed = await dispatchOutreachRunner(req);
  if (!handed.ok) return errorJson(502, "dispatch_failed", `The background worker could not be started (HTTP ${handed.status}).`);
  return Response.json({ data: { accepted: true, dispatched: true } }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
