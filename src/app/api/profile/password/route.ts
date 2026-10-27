import { z } from "zod";
import { protectedRoute } from "@/lib/api/protected-route";
import { readJsonBody } from "@/lib/api/responses";
import { setPassword } from "@/lib/profile/lock-service";
import { unlockedResponse } from "@/lib/profile/unlocked";

const body = z.strictObject({ password: z.string().max(1000), confirm: z.string().max(1000) });

/** First-time "Set Profile Password": both entries must match; only then is the hash stored and the Profile unlocked. */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    const { password, confirm } = body.parse(await readJsonBody(req));
    return unlockedResponse(memberId, await setPassword(memberId, password, confirm));
  },
  { mutates: true },
);
