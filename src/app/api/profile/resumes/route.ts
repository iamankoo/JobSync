import { protectedRoute } from "@/lib/api/protected-route";
import { readProfileUpload } from "@/lib/api/profile-upload";
import { ok } from "@/lib/api/responses";
import { DomainError } from "@/lib/google-sheets/errors";
import { addResume, listResumes } from "@/lib/google-sheets/member-files-service";
import { requireProfileUnlock } from "@/lib/profile/lock-service";

// Storing a file means a handful of Sheets writes.
export const maxDuration = 60;

/** The SIGNED-IN member's own resumes (never anyone else's). */
export const GET = protectedRoute(async ({ req, memberId }) => {
  await requireProfileUnlock(req, memberId);
  const list = await listResumes(memberId);
  if (!list) throw new DomainError("member_files_unavailable", "File uploads are not set up yet (the MemberFiles tab is missing).");
  return ok(list);
});

/** Uploads one resume (multipart `file`: PDF, DOC or DOCX, at most 2 MB). At most 10 per member, enforced here. */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    await requireProfileUnlock(req, memberId);
    const file = await readProfileUpload(req, memberId, "resume");
    return ok(await addResume(memberId, file), 201);
  },
  { mutates: true },
);
