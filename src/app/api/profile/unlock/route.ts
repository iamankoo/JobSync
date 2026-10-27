import { z } from "zod";
import { protectedRoute } from "@/lib/api/protected-route";
import { readJsonBody } from "@/lib/api/responses";
import { unlockWithPassword } from "@/lib/profile/lock-service";
import { unlockedResponse } from "@/lib/profile/unlocked";

const body = z.strictObject({ password: z.string().max(1000) });

/** Profile Password check. A wrong password returns only "Incorrect password." — never any profile data. */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    const { password } = body.parse(await readJsonBody(req));
    return unlockedResponse(memberId, await unlockWithPassword(memberId, password));
  },
  { mutates: true },
);
