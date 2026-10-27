import { z } from "zod";
import { protectedRoute } from "@/lib/api/protected-route";
import { readJsonBody } from "@/lib/api/responses";
import { unlockWithRecovery } from "@/lib/profile/lock-service";
import { unlockedResponse } from "@/lib/profile/unlocked";

const body = z.strictObject({ answer: z.string().max(200) });

/** "Another way to unlock" — the administrator (Anni) only, checked on the server, rate-limited. */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    const { answer } = body.parse(await readJsonBody(req));
    return unlockedResponse(memberId, await unlockWithRecovery(memberId, answer));
  },
  { mutates: true },
);
