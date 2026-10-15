import { protectedRoute } from "@/lib/api/protected-route";
import { whenChatReady } from "@/lib/api/chat";
import { ApiError, ok } from "@/lib/api/responses";
import { MAX_FILE_BYTES, MAX_VOICE_SECONDS, sanitizeFileName, validateUpload, type FileKind } from "@/lib/chat/files";
import { storeChatFile } from "@/lib/google-sheets/chat-files-service";
import { sendAttachmentMessage } from "@/lib/google-sheets/chat-service";
import { allowUpload } from "@/lib/chat/upload-throttle";

// Storing a file means a handful of Sheets writes.
export const maxDuration = 60;

const MULTIPART_OVERHEAD = 64 * 1024;
const VOICE_EXT: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav" };

/**
 * Uploads one attachment (multipart: `file`, `kind` = file | voice, optional `caption` and `durationSec`).
 * The browser's file name and MIME type are never trusted: the real bytes decide what the file is and whether it is allowed.
 */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    const declared = Number(req.headers.get("content-length"));
    if (!Number.isFinite(declared) || declared <= 0) throw new ApiError(411, "length_required", "The upload size is required.");
    if (declared > MAX_FILE_BYTES + MULTIPART_OVERHEAD) throw new ApiError(413, "file_too_large", "Files can be at most 2 MB.");
    if (!allowUpload(memberId)) throw new ApiError(429, "too_many_uploads", "You are sending files too quickly. Please wait a few minutes.");

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new ApiError(400, "invalid_upload", "The upload could not be read.");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "invalid_upload", "No file was attached.");
    const kind: FileKind = form.get("kind") === "voice" ? "voice" : "file";
    const caption = String(form.get("caption") ?? "").trim().slice(0, 500);
    const duration = Math.min(MAX_VOICE_SECONDS, Math.max(0, Math.round(Number(form.get("durationSec")) || 0)));

    if (file.size > MAX_FILE_BYTES) throw new ApiError(413, "file_too_large", "Files can be at most 2 MB.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = sanitizeFileName(file.name) || (kind === "voice" ? "voice-note" : "");
    // For voice notes the extension is derived from the content, so a recorder's odd naming never matters.
    const probe = kind === "voice" ? `voice-note.${VOICE_EXT[sniffAudio(bytes)] ?? "bin"}` : name;
    const checked = validateUpload(bytes, probe, kind);
    if (!checked.ok) throw new ApiError(checked.problem.code === "too_large" ? 413 : 400, `file_${checked.problem.code}`, checked.problem.message);

    const message = await whenChatReady(async () => {
      const fileId = await storeChatFile(bytes);
      return sendAttachmentMessage(memberId, {
        kind, fileId, fileName: kind === "voice" ? probe : name, mimeType: checked.detected.mime, sizeBytes: bytes.length,
        ...(kind === "voice" && duration ? { durationSec: duration } : {}), ...(caption ? { text: caption } : {}),
      });
    });
    return ok(message, 201);
  },
  { mutates: true },
);

function sniffAudio(b: Uint8Array): string {
  const a = (at: number, len: number) => String.fromCharCode(...b.slice(at, at + len));
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  if (a(0, 4) === "OggS") return "audio/ogg";
  if (a(4, 4) === "ftyp") return "audio/mp4";
  if (a(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (a(0, 4) === "RIFF" && a(8, 4) === "WAVE") return "audio/wav";
  return "";
}
