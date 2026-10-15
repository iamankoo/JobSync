import { protectedRoute } from "@/lib/api/protected-route";
import { whenChatReady } from "@/lib/api/chat";
import { ok } from "@/lib/api/responses";
import { countUnread } from "@/lib/google-sheets/chat-service";

/** Number of messages from the other members that the session member has not read yet. */
export const GET = protectedRoute(async ({ memberId }) => ok({ unread: await whenChatReady(() => countUnread(memberId)) }));
