import "server-only";
import { getSheetsClient } from "./client";
import { DomainError, SheetsError } from "./errors";
import { newId } from "./ids";
import { invalidateTableCache, checkTabHeader } from "./table";
import { columnLetter, TABS } from "./schema";

/**
 * Attachment bytes are stored as base64 in the `ChatFiles` tab, one row per chunk: `FileID | Seq | Data`.
 * Google Sheets limits a cell to 50,000 characters, so chunks are 40,000. This keeps JobSync on its single
 * existing store (no new account or paid service); the cost is the modest size limit in `lib/chat/files.ts`.
 *
 * The tab is never read as a whole table and no API returns it directly: bytes only leave through the
 * authorised download route, which first finds the message that references the FileID.
 */
const CHUNK_CHARS = 40_000;
const APPEND_BATCH = 10;
const WIDTH = columnLetter(TABS.chatFiles.headers.length);
const RANGE = `${TABS.chatFiles.name}!A:${WIDTH}`;

export const chunkCountFor = (sizeBytes: number) => Math.ceil((4 * Math.ceil(sizeBytes / 3)) / CHUNK_CHARS);

/** Stores `bytes` and returns the new FileID. Throws (and leaves at most orphaned chunks) on failure. */
export async function storeChatFile(bytes: Uint8Array): Promise<string> {
  const problems = await checkTabHeader("chatFiles");
  if (problems.length) throw new SheetsError("schema_invalid", "The ChatFiles tab is missing or has the wrong headers.");
  const fileId = newId("file");
  const base64 = Buffer.from(bytes).toString("base64");
  const rows: string[][] = [];
  for (let i = 0, seq = 0; i < base64.length; i += CHUNK_CHARS, seq++) rows.push([fileId, String(seq), base64.slice(i, i + CHUNK_CHARS)]);
  const client = getSheetsClient();
  try {
    for (let i = 0; i < rows.length; i += APPEND_BATCH) await client.appendValues(RANGE, rows.slice(i, i + APPEND_BATCH));
  } finally {
    invalidateTableCache();
  }
  return fileId;
}

/** Reads a stored file back, or throws `chat_file_not_found` if any chunk is missing. */
export async function loadChatFile(fileId: string, expectedBytes: number): Promise<Buffer> {
  const client = getSheetsClient();
  const ids = await client.getValues(`${TABS.chatFiles.name}!A:A`);
  const rowsOfFile: number[] = [];
  ids.forEach((r, i) => {
    if (i > 0 && r[0] === fileId) rowsOfFile.push(i + 1);
  });
  const expected = chunkCountFor(expectedBytes);
  if (rowsOfFile.length < expected) throw new DomainError("chat_file_not_found", "That file is no longer available.");
  const first = Math.min(...rowsOfFile);
  const last = Math.max(...rowsOfFile);
  const grid = await client.getValues(`${TABS.chatFiles.name}!A${first}:${WIDTH}${last}`);
  const chunks = new Map<number, string>();
  for (const r of grid) if (r[0] === fileId && !chunks.has(Number(r[1]))) chunks.set(Number(r[1]), r[2] ?? "");
  let base64 = "";
  for (let seq = 0; seq < expected; seq++) {
    const part = chunks.get(seq);
    if (part === undefined) throw new DomainError("chat_file_not_found", "That file is no longer available.");
    base64 += part;
  }
  const buf = Buffer.from(base64, "base64");
  if (buf.length !== expectedBytes) throw new DomainError("chat_file_not_found", "That file is no longer available.");
  return buf;
}
