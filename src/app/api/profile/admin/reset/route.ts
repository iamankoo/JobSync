import { z } from "zod";
import { protectedRoute } from "@/lib/api/protected-route";
import { ApiError, ok, readJsonBody } from "@/lib/api/responses";
import { ADMIN, requireProfileUnlock, resetPassword } from "@/lib/profile/lock-service";

const body = z.strictObject({ memberId: z.string().max(20) });

/**
 * Admin "Reset Passwords": clears the chosen member's Profile Password (they set a new one next time) and so ends
 * their current unlock. Only Anni, with his own Profile unlocked. Nothing about the old password is returned.
 */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    if (memberId !== ADMIN) throw new ApiError(403, "forbidden", "Only the administrator can reset passwords.");
    await requireProfileUnlock(req, memberId);
    const { memberId: target } = body.parse(await readJsonBody(req));
    return ok(await resetPassword(target));
  },
  { mutates: true },
);
