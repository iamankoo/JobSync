import { protectedRoute } from "@/lib/api/protected-route";
import { ApiError, ok } from "@/lib/api/responses";
import { SheetsError } from "@/lib/google-sheets/errors";
import { readPushSubscriptionsLocated } from "@/lib/google-sheets/repositories";
import { loadVapidConfig } from "@/lib/push/config";

/**
 * The PUBLIC VAPID key the browser needs to subscribe. 503 while push is not usable: VAPID keys missing or the
 * PushSubscriptions tab not created yet (so the app never invites members to enable something that cannot work).
 */
export const GET = protectedRoute(async () => {
  const vapid = loadVapidConfig();
  if (!vapid) throw new ApiError(503, "push_not_configured", "Push notifications are not set up on the server.");
  try {
    await readPushSubscriptionsLocated();
  } catch (err) {
    if (err instanceof SheetsError && err.code === "schema_invalid") {
      throw new ApiError(503, "push_not_configured", "Push notifications are not set up on the server.");
    }
    throw err;
  }
  return ok({ publicKey: vapid.publicKey });
});
