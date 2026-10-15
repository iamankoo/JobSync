import { protectedRoute } from "@/lib/api/protected-route";
import { whenChatReady } from "@/lib/api/chat";
import { loadChatFile } from "@/lib/google-sheets/chat-files-service";
import { DomainError } from "@/lib/google-sheets/errors";
import { readChatMessagesLocated } from "@/lib/google-sheets/repositories";
import { jobIdSchema } from "@/lib/validation/applications";

/** Types a browser may show inline; everything else is always a download. */
const INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|audio\/.+)$/;

/**
 * Serves one chat attachment to a signed-in, active member. There is no public URL: the file is looked up through
 * the message that references it (so only attachments that were actually posted can be read), and served with the
 * type recorded from the verified bytes, `nosniff`, and a restrictive policy.
 */
export const GET = protectedRoute<{ fileId: string }>(async ({ params }) => {
  const fileId = jobIdSchema.parse(params.fileId);
  return whenChatReady(async () => {
    const { items } = await readChatMessagesLocated();
    const msg = items.map((i) => i.value).find((m) => m.fileId === fileId);
    if (!msg || !msg.mimeType || !msg.sizeBytes) throw new DomainError("chat_file_not_found", "That file is no longer available.");
    const bytes = await loadChatFile(fileId, msg.sizeBytes);
    const inline = INLINE.test(msg.mimeType);
    const name = (msg.fileName ?? "download").replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": msg.mimeType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(msg.fileName ?? "download")}`,
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        // PDFs need the browser's viewer, which a sandbox policy would disable; everything else is fully sandboxed.
        ...(msg.mimeType === "application/pdf" ? {} : { "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox" }),
        // Per-viewer: the response is authorised by the session cookie and must never be shared by a proxy.
        "Cache-Control": "private, max-age=3600",
      },
    });
  });
});
