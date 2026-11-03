import { protectedRoute } from "@/lib/api/protected-route";
import { disposition } from "@/lib/api/profile-upload";
import { ok, readJsonBody } from "@/lib/api/responses";
import { z } from "zod";
import { deleteResume, loadResume, renameResume } from "@/lib/google-sheets/member-files-service";
import { requireProfileUnlock } from "@/lib/profile/lock-service";
import { jobIdSchema } from "@/lib/validation/applications";

/** Opens / downloads one of the caller's OWN resumes (another member's ID answers 404, like a missing file). */
export const GET = protectedRoute<{ recordId: string }>(async ({ req, memberId, params }) => {
  await requireProfileUnlock(req, memberId);
  const id = jobIdSchema.parse(params.recordId);
  const { info, bytes } = await loadResume(memberId, id);
  // PDFs open in the browser's viewer; Word files always download. `?download=1` forces a download.
  const inline = info.mimeType === "application/pdf" && new URL(req.url).searchParams.get("download") !== "1";
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": info.mimeType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": disposition(inline ? "inline" : "attachment", info.fileName),
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "private, no-store",
    },
  });
});

/** Renames one of the caller's own PDFs (metadata only: the file, its id and its storage reference are untouched). */
export const PATCH = protectedRoute<{ recordId: string }>(
  async ({ req, memberId, params }) => {
    await requireProfileUnlock(req, memberId);
    const id = jobIdSchema.parse(params.recordId);
    const { fileName } = z.strictObject({ fileName: z.string().max(200) }).parse(await readJsonBody(req));
    return ok(await renameResume(memberId, id, fileName));
  },
  { mutates: true },
);

export const DELETE = protectedRoute<{ recordId: string }>(
  async ({ req, memberId, params }) => {
    await requireProfileUnlock(req, memberId);
    const id = jobIdSchema.parse(params.recordId);
    return ok(await deleteResume(memberId, id));
  },
  { mutates: true },
);
