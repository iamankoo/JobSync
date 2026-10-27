import { protectedRoute } from "@/lib/api/protected-route";
import { readProfileUpload } from "@/lib/api/profile-upload";
import { ok } from "@/lib/api/responses";
import { setPhoto } from "@/lib/google-sheets/member-files-service";
import { requireProfileUnlock } from "@/lib/profile/lock-service";

export const maxDuration = 60;

/** Sets or replaces the SIGNED-IN member's own professional photo (JPEG, PNG or WebP, at most 2 MB). */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    await requireProfileUnlock(req, memberId);
    const file = await readProfileUpload(req, memberId, "photo");
    return ok(await setPhoto(memberId, file), 201);
  },
  { mutates: true },
);
