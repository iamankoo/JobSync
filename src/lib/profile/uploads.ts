import { MAX_FILE_BYTES, validateUpload } from "@/lib/chat/files";

/**
 * Profile upload rules, on top of the shared content check in lib/chat/files.ts (the real bytes decide the type;
 * the browser's name and MIME type are never trusted). Same 2 MB limit as the file store they share.
 */
export const PROFILE_MAX_BYTES = MAX_FILE_BYTES;
/** Resumes kept per member (enforced on the server; the UI mirrors it). */
export const MAX_RESUMES = 10;
/** Photos in each member's private Photos library (separate from the professional photo / avatar). Same cap as resumes. */
export const MAX_LIBRARY_PHOTOS = 10;

export const RESUME_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
};
export const RESUME_ACCEPT = ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WebP" };
export const PHOTO_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";

export type ProfileUploadKind = "resume" | "photo";

export function validateProfileUpload(bytes: Uint8Array, fileName: string, kind: ProfileUploadKind): { ok: true; mimeType: string } | { ok: false; status: number; code: string; message: string } {
  const checked = validateUpload(bytes, fileName, "file");
  const allowed = kind === "resume" ? RESUME_TYPES : PHOTO_TYPES;
  const wrongType = kind === "resume" ? "Upload a PDF, DOC or DOCX file." : "Upload a JPEG, PNG or WebP image.";
  if (!checked.ok) {
    if (checked.problem.code === "too_large") return { ok: false, status: 413, code: "file_too_large", message: checked.problem.message };
    if (checked.problem.code === "type_not_allowed") return { ok: false, status: 400, code: "file_type_not_allowed", message: wrongType };
    return { ok: false, status: 400, code: `file_${checked.problem.code}`, message: checked.problem.message };
  }
  if (!allowed[checked.detected.mime]) return { ok: false, status: 400, code: "file_type_not_allowed", message: wrongType };
  return { ok: true, mimeType: checked.detected.mime };
}
