import { z } from "zod";
import { MEMBER_IDS, getMember } from "@/config/members";
import { protectedRoute } from "@/lib/api/protected-route";
import { whenChatReady } from "@/lib/api/chat";
import { ok, readJsonBody } from "@/lib/api/responses";
import { applyCallAction, MAX_PAYLOAD_CHARS } from "@/lib/google-sheets/call-service";
import { sendCallMessage } from "@/lib/google-sheets/chat-service";
import { ID_PATTERN } from "@/lib/validation/applications";
import { notifyCallStarted } from "@/lib/push/notify";

const callSchema = z.strictObject({
  action: z.enum(["start", "join", "offer", "answer", "leave", "ping", "end"]),
  callId: z.string().regex(ID_PATTERN).optional(),
  to: z.enum(MEMBER_IDS).optional(),
  media: z.enum(["audio", "video"]).optional(),
  payload: z.string().max(MAX_PAYLOAD_CHARS).optional(),
});

/**
 * One WebRTC signalling event (start / join / offer / answer / leave / ping) from the session member. Offers and
 * answers are small text descriptions; media never passes through the server (it flows browser-to-browser).
 */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    const input = callSchema.parse(await readJsonBody(req, 48 * 1024));
    return whenChatReady(async () => {
      const result = await applyCallAction(memberId, input);
      if (result.started && result.call) {
        const media = result.call.media;
        const who = getMember(memberId)?.name ?? "Someone";
        // The chat line (also what makes other members' polls look at the signalling log) and a push for the others.
        await sendCallMessage(memberId, result.call.callId, `${who} started ${media === "video" ? "a video" : "an audio"} call`);
        await notifyCallStarted(memberId, result.call.callId, media);
      }
      return ok({ call: result.call, at: result.at }, result.started ? 201 : 200);
    });
  },
  { mutates: true },
);
