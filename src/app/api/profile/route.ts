import { protectedRoute } from "@/lib/api/protected-route";
import { ok, readJsonBody } from "@/lib/api/responses";
import { readProfile, saveProfile } from "@/lib/google-sheets/profile-service";
import { requireProfileUnlock } from "@/lib/profile/lock-service";
import { profileSchema } from "@/lib/validation/profile";

/** The SIGNED-IN member's own profile, only with an unlocked Profile. There is no way to name another member. */
export const GET = protectedRoute(async ({ req, memberId }) => {
  await requireProfileUnlock(req, memberId);
  return ok(await readProfile(memberId));
});

export const PUT = protectedRoute(
  async ({ req, memberId }) => {
    await requireProfileUnlock(req, memberId);
    const input = profileSchema.parse(await readJsonBody(req));
    return ok(await saveProfile(memberId, input));
  },
  { mutates: true },
);
