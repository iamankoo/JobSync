import { protectedRoute } from "@/lib/api/protected-route";
import { sendMessageSchema, whenChatReady } from "@/lib/api/chat";
import { ok, readJsonBody } from "@/lib/api/responses";
import { sendTextMessage } from "@/lib/google-sheets/chat-service";

/** Posts a text message as the session member. The body cannot name a sender. */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    const { text } = sendMessageSchema.parse(await readJsonBody(req));
    return ok(await whenChatReady(() => sendTextMessage(memberId, text)), 201);
  },
  { mutates: true },
);
