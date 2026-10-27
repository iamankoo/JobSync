import { protectedRoute } from "@/lib/api/protected-route";
import { disposition } from "@/lib/api/profile-upload";
import { ok } from "@/lib/api/responses";
import { deleteResume, loadResume } from "@/lib/google-sheets/member-files-service";
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

export const DELETE = protectedRoute<{ recordId: string }>(
  async ({ req, memberId, params }) => {
    await requireProfileUnlock(req, memberId);
    const id = jobIdSchema.parse(params.recordId);
    return ok(await deleteResume(memberId, id));
  },
  { mutates: true },
);
