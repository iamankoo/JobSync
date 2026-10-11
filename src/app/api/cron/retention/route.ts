import { createHash, timingSafeEqual } from "node:crypto";
import { errorJson, errorResponse, ok } from "@/lib/api/responses";
import { planRetention, retentionEnabled, runRetention } from "@/lib/google-sheets/retention-service";

const digest = (v: string) => createHash("sha256").update(v).digest();

/**
 * Retention endpoint for a scheduler (or a manual dry run). Authenticated with
 * `Authorization: Bearer $CRON_SECRET`; it has no session because it is not a member action.
 *
 *  - Default: DRY RUN. Returns what would be deleted and changes nothing.
 *  - Only when RETENTION_CLEANUP_ENABLED=true does it actually delete jobs older than 30 days
 *    (and their application rows). It is disabled until the owner has reviewed a dry run.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return errorJson(503, "cron_disabled", "The retention endpoint is not configured (CRON_SECRET is not set).");
  const given = req.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) return errorJson(401, "unauthenticated", "Invalid credentials.");

  try {
    if (!retentionEnabled()) return ok({ dryRun: true, ...(await planRetention()) });
    return ok({ dryRun: false, ...(await runRetention()) });
  } catch (err) {
    return errorResponse(err);
  }
}
