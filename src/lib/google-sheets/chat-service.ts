import "server-only";
import type { MemberId } from "@/config/members";
import type { ChatMessage } from "@/types/domain";
import { nowIso } from "@/lib/utils/time";
import { newId } from "./ids";
import { withWriteLock } from "./lock";
import { appendChatMessage, appendChatRead, readChatMessagesLocated, readChatReadsLocated, updateChatReadRow } from "./repositories";

/** Chat polls share one short-lived read of the messages tab (see table.ts): fresher than the dashboards' default. */
export const CHAT_CACHE_MS = 2_500;
/** How many of the newest messages a first load returns. */
export const INITIAL_MESSAGES = 100;
/** Hard cap on one poll response. */
const MAX_PER_POLL = 300;
export const MAX_TEXT = 4000;
/** A call announcement older than this can no longer be a live call (mirrors CALL_MAX_MS in call-service). */
const CALL_WINDOW_MS = 3 * 3_600_000;

/** A chat message plus its spreadsheet row, which is the stable, ever-increasing sequence number used as a cursor. */
export interface SequencedMessage extends ChatMessage {
  seq: number;
}

export interface MessagePage {
  messages: SequencedMessage[];
  /** Highest row number seen so far (pass back as `after`). */
  cursor: number;
  /** The row the caller has read up to. */
  lastReadRow: number;
  /** How far each member has read (spreadsheet row), for the seen-by avatars. */
  readers: Partial<Record<MemberId, number>>;
  /** A call was announced in the last few hours, so the signalling log is worth reading. */
  recentCall: boolean;
}

/**
 * Messages after `afterRow` (0 = the newest INITIAL_MESSAGES). Rows are never deleted, so a row number is a
 * stable cursor across polls and instances.
 */
export async function listMessages(memberId: MemberId, afterRow: number, options: { fresh?: boolean } = {}, now: Date = new Date()): Promise<MessagePage> {
  const [msgs, reads] = await Promise.all([
    readChatMessagesLocated({ maxAgeMs: CHAT_CACHE_MS, fresh: options.fresh }),
    readChatReadsLocated({ maxAgeMs: CHAT_CACHE_MS, fresh: options.fresh }),
  ]);
  const all: SequencedMessage[] = msgs.items.map((i) => ({ ...i.value, seq: i.row }));
  const picked = afterRow > 0 ? all.filter((m) => m.seq > afterRow).slice(0, MAX_PER_POLL) : all.slice(-INITIAL_MESSAGES);
  const cursor = picked.length ? picked[picked.length - 1].seq : Math.max(afterRow, all.length ? all[all.length - 1].seq : 0);
  const mine = reads.items.find((r) => r.value.memberId === memberId);
  const recentCall = all.some((m) => m.kind === "call" && now.getTime() - Date.parse(m.createdAt) < CALL_WINDOW_MS);
  const readers = Object.fromEntries(reads.items.map((r) => [r.value.memberId, r.value.lastReadRow])) as Partial<Record<MemberId, number>>;
  return { messages: picked, cursor, lastReadRow: mine?.value.lastReadRow ?? 0, readers, recentCall };
}

export async function sendTextMessage(memberId: MemberId, text: string, now: Date = new Date()): Promise<ChatMessage> {
  const message: ChatMessage = { messageId: newId("msg"), memberId, kind: "text", text, createdAt: nowIso(now) };
  await withWriteLock(() => appendChatMessage(message));
  return message;
}

/** Records an attachment message after its bytes are safely stored. `text` is an optional caption. */
export async function sendAttachmentMessage(
  memberId: MemberId,
  input: { kind: "file" | "voice"; fileId: string; fileName: string; mimeType: string; sizeBytes: number; durationSec?: number; text?: string },
  now: Date = new Date(),
): Promise<ChatMessage> {
  const message: ChatMessage = {
    messageId: newId("msg"), memberId, kind: input.kind, text: input.text ?? "", fileId: input.fileId, fileName: input.fileName,
    mimeType: input.mimeType, sizeBytes: input.sizeBytes, durationSec: input.durationSec, createdAt: nowIso(now),
  };
  await withWriteLock(() => appendChatMessage(message));
  return message;
}

/** System line in the chat for a call ("Anni started a video call"). `callId` rides in FileName. */
export async function sendCallMessage(memberId: MemberId, callId: string, text: string, now: Date = new Date()): Promise<ChatMessage> {
  const message: ChatMessage = { messageId: newId("msg"), memberId, kind: "call", text, fileName: callId, createdAt: nowIso(now) };
  await withWriteLock(() => appendChatMessage(message));
  return message;
}

/** Marks everything up to `upToRow` as read for `memberId` (never moves backwards). */
export async function markRead(memberId: MemberId, upToRow: number, now: Date = new Date()): Promise<{ lastReadRow: number }> {
  return withWriteLock(async () => {
    const [{ items: reads }, { items: msgs }] = await Promise.all([readChatReadsLocated({ fresh: true }), readChatMessagesLocated({ fresh: true })]);
    const newest = msgs.length ? msgs[msgs.length - 1].row : 0;
    const target = Math.max(1, Math.min(upToRow, newest || 1));
    const mine = reads.find((r) => r.value.memberId === memberId);
    if (!mine) {
      await appendChatRead({ memberId, lastReadRow: target, updatedAt: nowIso(now) });
      return { lastReadRow: target };
    }
    if (target <= mine.value.lastReadRow) return { lastReadRow: mine.value.lastReadRow };
    await updateChatReadRow(mine.row, { memberId, lastReadRow: target, updatedAt: nowIso(now) });
    return { lastReadRow: target };
  });
}

/** Messages from other members that `memberId` has not read yet. */
export async function countUnread(memberId: MemberId): Promise<number> {
  const [{ items: msgs }, { items: reads }] = await Promise.all([readChatMessagesLocated(), readChatReadsLocated()]);
  const lastRead = reads.find((r) => r.value.memberId === memberId)?.value.lastReadRow ?? 0;
  return msgs.filter((m) => m.row > lastRead && m.value.memberId !== memberId).length;
}
