import { createHash, timingSafeEqual } from "node:crypto";
import { errorJson, errorResponse } from "@/lib/api/responses";
import { runDailyNotifications } from "@/lib/push/daily-run";
import { NOTIFICATION_TYPES, type NotificationType } from "@/types/domain";

// Sending to three members plus Sheets round-trips can take a few seconds.
export const maxDuration = 60;

const digest = (v: string) => createHash("sha256").update(v).digest();

/**
 * Scheduled (10 AM / 10 PM) notifications. Authenticated with `Authorization: Bearer $CRON_SECRET` (Vercel Cron
 * sends it automatically when CRON_SECRET is set); there is no member session because it is not a member action.
 *
 *   GET /api/cron/daily-notifications?slot=morning|night
 *
 * Safe to call repeatedly: each member receives each slot at most once per local date. Calls outside the slot's
 * local-time window are refused (409), so a mis-timed call cannot send "good night" at noon.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return errorJson(503, "cron_disabled", "Scheduled notifications are not configured (CRON_SECRET is not set).");
  const given = req.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) return errorJson(401, "unauthenticated", "Invalid credentials.");

  const slot = new URL(req.url).searchParams.get("slot");
  if (!NOTIFICATION_TYPES.includes(slot as NotificationType)) return errorJson(400, "validation_failed", 'Query "slot" must be "morning" or "night".');

  try {
    const run = await runDailyNotifications(slot as NotificationType);
    if (!run.ran) {
      return errorJson(run.reason === "push_not_configured" ? 503 : 409, run.reason, run.reason === "outside_window" ? "This slot is outside its local-time window; nothing was sent." : "Push notifications are not set up on the server.", { date: run.date });
    }
    // A member that failed (not merely "already sent") makes the run report 503 so a scheduler can retry it.
    const retryable = run.results.some((r) => r.outcome === "error" || r.outcome === "delivery_failed");
    return Response.json({ data: run }, { status: retryable ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
