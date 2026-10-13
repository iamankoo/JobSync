import { protectedRoute } from "@/lib/api/protected-route";
import { ApiError, ok, readJsonBody } from "@/lib/api/responses";
import { SheetsError } from "@/lib/google-sheets/errors";
import { isSubscriptionRegistered } from "@/lib/google-sheets/push-service";
import { loadVapidConfig } from "@/lib/push/config";
import { unsubscribeSchema } from "@/lib/push/validation";

/**
 * Is THIS browser's subscription stored on the server for the SESSION member? Read-only (POST only because the
 * endpoint is a secret that must not appear in a URL). A subscription stored for another member reports false.
 */
export const POST = protectedRoute(async ({ req, memberId }) => {
  if (!loadVapidConfig()) throw new ApiError(503, "push_not_configured", "Push notifications are not set up on the server.");
  const { endpoint } = unsubscribeSchema.parse(await readJsonBody(req));
  try {
    return ok({ registered: await isSubscriptionRegistered(memberId, endpoint) });
  } catch (err) {
    if (err instanceof SheetsError && err.code === "schema_invalid") {
      throw new ApiError(503, "push_not_configured", "Push notifications are not set up on the server.");
    }
    throw err;
  }
});
