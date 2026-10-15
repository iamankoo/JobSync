import { protectedRoute } from "@/lib/api/protected-route";
import { readSchema, whenChatReady } from "@/lib/api/chat";
import { ok, readJsonBody } from "@/lib/api/responses";
import { markRead } from "@/lib/google-sheets/chat-service";

/** Marks the chat as read up to a message row for the session member. */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    const { upToRow } = readSchema.parse(await readJsonBody(req));
    return ok(await whenChatReady(() => markRead(memberId, upToRow)));
  },
  { mutates: true },
);
