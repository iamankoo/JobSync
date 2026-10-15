import { protectedRoute } from "@/lib/api/protected-route";
import { pollSchema, whenChatReady } from "@/lib/api/chat";
import { ok } from "@/lib/api/responses";
import { getCallState, type CallState } from "@/lib/google-sheets/call-service";
import { listMessages } from "@/lib/google-sheets/chat-service";
import { SheetsError } from "@/lib/google-sheets/errors";

const NO_CALL: CallState = { active: null, signals: [], cursor: "" };

/**
 * The chat's heartbeat (short polling): new messages after the `after` row cursor, plus, only while a call may be
 * live, the call state and the signals addressed to the caller. Identity comes from the session.
 */
export const GET = protectedRoute(async ({ req, memberId }) => {
  const query = pollSchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  return whenChatReady(async () => {
    const page = await listMessages(memberId, query.after);
    let call = NO_CALL;
    let callsAvailable = true;
    if (page.recentCall) {
      try {
        call = await getCallState(memberId, query.since ?? null);
      } catch (err) {
        // Calls are an add-on: a missing signalling tab must not take the text chat down with it.
        if (!(err instanceof SheetsError && err.code === "schema_invalid")) throw err;
        callsAvailable = false;
      }
    }
    return ok({ ...page, call, callsAvailable });
  });
});
