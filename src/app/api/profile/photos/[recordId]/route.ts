import { protectedRoute } from "@/lib/api/protected-route";
import { disposition } from "@/lib/api/profile-upload";
import { ok } from "@/lib/api/responses";
import { deleteLibraryPhoto, loadLibraryPhoto } from "@/lib/google-sheets/member-files-service";
import { requireProfileUnlock } from "@/lib/profile/lock-service";
import { jobIdSchema } from "@/lib/validation/applications";

/** Views (inline) or downloads (`?download=1`) one of the caller's OWN library photos; another member's ID answers 404. */
export const GET = protectedRoute<{ recordId: string }>(async ({ req, memberId, params }) => {
  await requireProfileUnlock(req, memberId);
  const id = jobIdSchema.parse(params.recordId);
  const { info, bytes } = await loadLibraryPhoto(memberId, id);
  const download = new URL(req.url).searchParams.get("download") === "1";
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": info.mimeType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": disposition(download ? "attachment" : "inline", info.fileName),
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
});

export const DELETE = protectedRoute<{ recordId: string }>(
  async ({ req, memberId, params }) => {
    await requireProfileUnlock(req, memberId);
    const id = jobIdSchema.parse(params.recordId);
    return ok(await deleteLibraryPhoto(memberId, id));
  },
  { mutates: true },
);
