/**
 * Renaming an uploaded PDF changes only its displayed name. Pure rules, shared by the rename control (client) and the server
 * (the server is the authority). The `.pdf` extension is always kept: the member types the name, we add the extension.
 */
export const PDF_NAME_MAX = 100; // same cap as uploads (lib/chat/files.ts MAX_FILE_NAME), extension included
const INVALID_CHARS = /[\\/:*?"<>|\u0000-\u001F\u007F]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export type PdfNameResult = { ok: true; fileName: string } | { ok: false; message: string };

export function normalizePdfName(raw: string): PdfNameResult {
  // Whitespace is trimmed and a typed ".pdf" is not doubled.
  const base = raw.trim().replace(/\.pdf$/i, "").trim();
  if (!base) return { ok: false, message: "Enter a file name." };
  if (INVALID_CHARS.test(base)) return { ok: false, message: 'A file name cannot contain \\ / : * ? " < > | or control characters.' };
  if (/^\.+$/.test(base) || /[. ]$/.test(base)) return { ok: false, message: "A file name cannot end with a dot or a space." };
  if (RESERVED.test(base)) return { ok: false, message: "That name is reserved by the system. Choose another." };
  const fileName = `${base}.pdf`;
  if (fileName.length > PDF_NAME_MAX) return { ok: false, message: `Use at most ${PDF_NAME_MAX - 4} characters (the .pdf is added for you).` };
  return { ok: true, fileName };
}

/** Names are unique per member, ignoring case (the same rule as Windows/macOS file systems). */
export const sameFileName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
