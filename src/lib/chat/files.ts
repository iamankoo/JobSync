/**
 * Group-chat attachment rules. Pure and dependency-free so the SAME rules run in the browser (instant feedback)
 * and on the server (the authority: it re-checks the real bytes, never trusting the browser's name or MIME type).
 */

/** Largest attachment. Bytes live in the Google Sheet as base64 chunks, so this is deliberately modest. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_NAME = 100;
export const MAX_VOICE_SECONDS = 180;

export type FileCategory = "image" | "pdf" | "audio" | "document" | "text" | "archive";

export interface DetectedFile {
  mime: string;
  category: FileCategory;
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.slice(at, at + len));

/** What a file name is allowed to end with, per detected content type. */
const EXTENSIONS: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
  "audio/webm": ["webm", "weba", "mka"],
  "audio/ogg": ["ogg", "oga", "opus"],
  "audio/mp4": ["m4a", "aac"],
  "audio/mpeg": ["mp3"],
  "audio/wav": ["wav"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
  "application/zip": ["zip"],
  "application/msword": ["doc"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.ms-powerpoint": ["ppt"],
  "application/rtf": ["rtf"],
  "text/plain": ["txt", "md", "log"],
  "text/csv": ["csv"],
};

const CATEGORY: Record<string, FileCategory> = {
  "image/png": "image", "image/jpeg": "image", "image/gif": "image", "image/webp": "image",
  "application/pdf": "pdf",
  "audio/webm": "audio", "audio/ogg": "audio", "audio/mp4": "audio", "audio/mpeg": "audio", "audio/wav": "audio",
  "application/zip": "archive",
  "text/plain": "text", "text/csv": "text",
};

/** Every extension a file picker may offer (also used for the input's `accept`). */
export const ACCEPTED_EXTENSIONS = [...new Set(Object.values(EXTENSIONS).flat())].filter((e) => !["weba", "mka", "oga", "aac", "opus"].includes(e));

const extensionOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

/** A safe display/download name: no path parts, no control characters, bounded length. */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001F\u007F"<>|:*?]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (cleaned.length <= MAX_FILE_NAME) return cleaned;
  const ext = extensionOf(cleaned);
  const keep = MAX_FILE_NAME - (ext ? ext.length + 1 : 0);
  return ext ? `${cleaned.slice(0, keep)}.${ext}` : cleaned.slice(0, MAX_FILE_NAME);
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (const b of bytes) if (b === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Identifies a file from its CONTENT (magic bytes). Anything not recognised is refused, which also excludes
 * executables, scripts, HTML and SVG (script-capable). Returns null when the file is not allowed.
 */
export function detectFile(bytes: Uint8Array, fileName: string): DetectedFile | null {
  const ext = extensionOf(fileName);
  const found = ((): string | null => {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (ascii(bytes, 0, 4) === "GIF8") return "image/gif";
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
    if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
    if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "audio/webm";
    if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
    if (ascii(bytes, 4, 4) === "ftyp") return "audio/mp4";
    if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
    if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
      if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      if (ext === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      return "application/zip";
    }
    if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
      if (ext === "xls") return "application/vnd.ms-excel";
      if (ext === "ppt") return "application/vnd.ms-powerpoint";
      return "application/msword";
    }
    if (ascii(bytes, 0, 5) === "{\\rtf") return "application/rtf";
    if (looksLikeText(bytes)) return ext === "csv" ? "text/csv" : "text/plain";
    return null;
  })();
  if (!found) return null;
  // The name must agree with the content (a ".png" that is really a program is refused).
  if (!EXTENSIONS[found].includes(ext)) return null;
  return { mime: found, category: CATEGORY[found] ?? "document" };
}

export type FileKind = "file" | "voice";

export interface FileProblem {
  code: "empty" | "too_large" | "type_not_allowed" | "not_audio" | "name_missing";
  message: string;
}

const MB = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

/** Full validation of an upload. Returns the detected type or a user-facing problem. */
export function validateUpload(bytes: Uint8Array, fileName: string, kind: FileKind): { ok: true; detected: DetectedFile } | { ok: false; problem: FileProblem } {
  if (bytes.length === 0) return { ok: false, problem: { code: "empty", message: "That file is empty." } };
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, problem: { code: "too_large", message: `Files can be at most ${MB(MAX_FILE_BYTES)}.` } };
  if (!fileName) return { ok: false, problem: { code: "name_missing", message: "The file needs a name." } };
  const detected = detectFile(bytes, fileName);
  if (!detected) {
    return { ok: false, problem: { code: "type_not_allowed", message: "This file type is not allowed. Send images, PDFs, audio, Office documents, text/CSV or ZIP files." } };
  }
  if (kind === "voice" && detected.category !== "audio") return { ok: false, problem: { code: "not_audio", message: "A voice note must be an audio recording." } };
  return { ok: true, detected };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
