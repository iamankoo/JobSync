import { protectedRoute } from "@/lib/api/protected-route";
import { ApiError, ok, readJsonBody } from "@/lib/api/responses";
import { SheetsError } from "@/lib/google-sheets/errors";
import { removeSubscription, saveSubscription } from "@/lib/google-sheets/push-service";
import { loadVapidConfig } from "@/lib/push/config";
import { subscribeSchema, unsubscribeSchema } from "@/lib/push/validation";

/** The PushSubscriptions tab is created by hand; until then push is unavailable but nothing else breaks. */
function unavailable(err: unknown): never {
  if (err instanceof SheetsError && err.code === "schema_invalid") {
    throw new ApiError(503, "push_not_configured", "Push notifications are not set up on the server.");
  }
  throw err;
}

/** Registers the CALLER's browser. The owner is always the session member; the body cannot name one. */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    if (!loadVapidConfig()) throw new ApiError(503, "push_not_configured", "Push notifications are not set up on the server.");
    const input = subscribeSchema.parse(await readJsonBody(req));
    const result = await saveSubscription(memberId, input).catch(unavailable);
    return ok({ registered: true, created: result.created }, result.created ? 201 : 200);
  },
  { mutates: true },
);

/** Removes the CALLER's own subscription for this browser (e.g. on logout). Other devices are untouched. */
export const DELETE = protectedRoute(
  async ({ req, memberId }) => {
    const input = unsubscribeSchema.parse(await readJsonBody(req));
    const result = await removeSubscription(memberId, input.endpoint).catch(unavailable);
    return ok({ removed: result.removed });
  },
  { mutates: true },
);
