import "server-only";
import type { MemberId } from "@/config/members";
import { sanitizeFileName } from "@/lib/chat/files";
import { allowUpload } from "@/lib/chat/upload-throttle";
import { PROFILE_MAX_BYTES, validateProfileUpload, type ProfileUploadKind } from "@/lib/profile/uploads";
import { ApiError } from "./responses";

const MULTIPART_OVERHEAD = 64 * 1024;
const TOO_LARGE = `Files can be at most ${PROFILE_MAX_BYTES / 1024 / 1024} MB.`;

/** Reads and verifies the single `file` of a multipart profile upload. File contents are never logged. */
export async function readProfileUpload(req: Request, memberId: MemberId, kind: ProfileUploadKind): Promise<{ bytes: Uint8Array; fileName: string; mimeType: string }> {
  const declared = Number(req.headers.get("content-length"));
  if (!Number.isFinite(declared) || declared <= 0) throw new ApiError(411, "length_required", "The upload size is required.");
  if (declared > PROFILE_MAX_BYTES + MULTIPART_OVERHEAD) throw new ApiError(413, "file_too_large", TOO_LARGE);
  if (!allowUpload(memberId)) throw new ApiError(429, "too_many_uploads", "You are uploading files too quickly. Please wait a few minutes.");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError(400, "invalid_upload", "The upload could not be read.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "invalid_upload", "No file was attached.");
  if (file.size > PROFILE_MAX_BYTES) throw new ApiError(413, "file_too_large", TOO_LARGE);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileName = sanitizeFileName(file.name);
  const checked = validateProfileUpload(bytes, fileName, kind);
  if (!checked.ok) throw new ApiError(checked.status, checked.code, checked.message);
  return { bytes, fileName, mimeType: checked.mimeType };
}

/** `Content-Disposition` with a safe ASCII fallback name. */
export function disposition(type: "inline" | "attachment", fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
