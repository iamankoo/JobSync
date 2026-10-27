import { protectedRoute } from "@/lib/api/protected-route";
import { readProfileUpload } from "@/lib/api/profile-upload";
import { ok } from "@/lib/api/responses";
import { DomainError } from "@/lib/google-sheets/errors";
import { addLibraryPhoto, listLibraryPhotos } from "@/lib/google-sheets/member-files-service";
import { requireProfileUnlock } from "@/lib/profile/lock-service";

// Storing a file means a handful of Sheets writes.
export const maxDuration = 60;

/** The SIGNED-IN member's own Photos library (never anyone else's), only with an unlocked Profile. */
export const GET = protectedRoute(async ({ req, memberId }) => {
  await requireProfileUnlock(req, memberId);
  const list = await listLibraryPhotos(memberId);
  if (!list) throw new DomainError("member_files_unavailable", "File uploads are not set up yet (the MemberFiles tab is missing).");
  return ok(list);
});

/**
 * Adds one photo to the member's private Photos library (multipart `file`: JPEG, PNG or WebP, at most 2 MB; at most 10
 * photos). This NEVER changes the professional photo / avatar (that is POST /api/profile/photo).
 */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    await requireProfileUnlock(req, memberId);
    const file = await readProfileUpload(req, memberId, "photo");
    return ok(await addLibraryPhoto(memberId, file), 201);
  },
  { mutates: true },
);
