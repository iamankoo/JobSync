import "server-only";
import { MEMBER_IDS, type MemberId } from "@/config/members";
import { MAX_LIBRARY_PHOTOS, MAX_RESUMES } from "@/lib/profile/uploads";
import { getSheetsClient } from "./client";
import { deleteStoredFile, loadChatFile, storeChatFile } from "./chat-files-service";
import { DomainError, SheetsError } from "./errors";
import { newId } from "./ids";
import { withWriteLock } from "./lock";
import { rowRange, tableRange, TABS } from "./schema";
import { checkTabHeader, invalidateTableCache, readTable } from "./table";

/**
 * Profile uploads (resumes and the professional photo). Metadata rows in MemberFiles tie each file to its member;
 * the bytes live in the existing file store (ChatFiles chunks). Every function takes the SESSION member — a
 * record of another member is treated exactly like a missing one.
 */
export { MAX_RESUMES, MAX_LIBRARY_PHOTOS };
/**
 * "resume" = resumes; "photo" = the ONE professional photo used as the member's avatar; "library_photo" = the
 * member's private Photos library (never used as the avatar).
 */
export type MemberFileKind = "resume" | "photo" | "library_photo";
const KINDS: readonly MemberFileKind[] = ["resume", "photo", "library_photo"];

export interface MemberFile {
  recordId: string;
  memberId: MemberId;
  kind: MemberFileKind;
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

/** What the browser may see about a resume (the internal FileID stays on the server). */
export type ResumeInfo = Pick<MemberFile, "recordId" | "fileName" | "mimeType" | "sizeBytes" | "uploadedAt">;
export const toResumeInfo = ({ recordId, fileName, mimeType, sizeBytes, uploadedAt }: MemberFile): ResumeInfo => ({ recordId, fileName, mimeType, sizeBytes, uploadedAt });

async function readAll(fresh = false): Promise<(MemberFile & { row: number })[]> {
  const out: (MemberFile & { row: number })[] = [];
  for (const { row, cells } of await readTable("memberFiles", { fresh })) {
    const [recordId, memberId, kind, fileId, fileName, mimeType, sizeBytes, uploadedAt] = cells.map((c) => c.trim());
    const size = Number(sizeBytes);
    if (!recordId || !fileId || !(MEMBER_IDS as readonly string[]).includes(memberId) || !(KINDS as readonly string[]).includes(kind) || !Number.isInteger(size) || size <= 0) continue;
    out.push({ row, recordId, memberId: memberId as MemberId, kind: kind as MemberFileKind, fileId, fileName, mimeType, sizeBytes: size, uploadedAt });
  }
  return out;
}

const serialize = (f: MemberFile) => [f.recordId, f.memberId, f.kind, f.fileId, f.fileName, f.mimeType, String(f.sizeBytes), f.uploadedAt];

/** Uploads need both tabs; a clear 503 instead of a half-written file. */
async function requireTabs() {
  for (const tab of ["memberFiles", "chatFiles"] as const) {
    let problems: string[];
    try {
      problems = await checkTabHeader(tab);
    } catch (err) {
      if (!(err instanceof SheetsError && err.code === "schema_invalid")) throw err;
      problems = ["missing"];
    }
    if (problems.length) throw new DomainError("member_files_unavailable", `File uploads are not set up yet (the ${TABS[tab].name} tab is missing).`);
  }
}

// ---- listed files (resumes, Photos library): same rules, separate kinds ---------------------------------------

type ListedKind = "resume" | "library_photo";
const LISTED: Record<ListedKind, { max: number; prefix: "res" | "lph"; limitMessage: string }> = {
  resume: { max: MAX_RESUMES, prefix: "res", limitMessage: `You can keep at most ${MAX_RESUMES} resumes. Delete one to upload another.` },
  library_photo: { max: MAX_LIBRARY_PHOTOS, prefix: "lph", limitMessage: `You can keep at most ${MAX_LIBRARY_PHOTOS} photos. Delete one to upload another.` },
};

async function listOwn(memberId: MemberId, kind: ListedKind): Promise<ResumeInfo[] | null> {
  try {
    return (await readAll()).filter((f) => f.memberId === memberId && f.kind === kind).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)).map(toResumeInfo);
  } catch (err) {
    if (err instanceof SheetsError && err.code === "schema_invalid") return null;
    throw err;
  }
}

async function addOwn(memberId: MemberId, kind: ListedKind, file: { bytes: Uint8Array; fileName: string; mimeType: string }, now: Date): Promise<ResumeInfo> {
  await requireTabs();
  const rules = LISTED[kind];
  return withWriteLock(async () => {
    const mine = (await readAll(true)).filter((f) => f.memberId === memberId && f.kind === kind);
    if (mine.length >= rules.max) throw new DomainError("resume_limit", rules.limitMessage);
    const fileId = await storeChatFile(file.bytes);
    const rec: MemberFile = { recordId: newId(rules.prefix), memberId, kind, fileId, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.bytes.length, uploadedAt: now.toISOString() };
    try {
      await getSheetsClient().appendValues(tableRange("memberFiles"), [serialize(rec)]);
    } finally {
      invalidateTableCache();
    }
    return toResumeInfo(rec);
  });
}

async function findOwn(memberId: MemberId, recordId: string, kind: MemberFileKind, fresh = false) {
  const hit = (await readAll(fresh)).find((f) => f.recordId === recordId && f.kind === kind);
  // Another member's record answers exactly like a missing one (no hint that it exists).
  if (!hit || hit.memberId !== memberId) throw new DomainError("member_file_not_found", "That file is no longer available.");
  return hit;
}

async function deleteOwn(memberId: MemberId, recordId: string, kind: ListedKind): Promise<{ recordId: string }> {
  return withWriteLock(async () => {
    const rec = await findOwn(memberId, recordId, kind, true);
    try {
      await getSheetsClient().deleteRows(TABS.memberFiles.name, [rec.row]);
    } finally {
      invalidateTableCache();
    }
    await deleteStoredFile(rec.fileId);
    return { recordId };
  });
}

/** The member's resumes, newest first; null while the MemberFiles tab does not exist. */
export const listResumes = (memberId: MemberId) => listOwn(memberId, "resume");
export const addResume = (memberId: MemberId, file: { bytes: Uint8Array; fileName: string; mimeType: string }, now: Date = new Date()) => addOwn(memberId, "resume", file, now);
export async function loadResume(memberId: MemberId, recordId: string): Promise<{ info: ResumeInfo; bytes: Buffer }> {
  const rec = await findOwn(memberId, recordId, "resume");
  return { info: toResumeInfo(rec), bytes: await loadStored(rec) };
}
export const deleteResume = (memberId: MemberId, recordId: string) => deleteOwn(memberId, recordId, "resume");

// ---- Photos library (private; NEVER the avatar) --------------------------------------------------------------

/** Same public shape as a resume entry (no internal FileID). */
export type LibraryPhotoInfo = ResumeInfo;
/** The member's Photos library, newest first; null while the MemberFiles tab does not exist. */
export const listLibraryPhotos = (memberId: MemberId) => listOwn(memberId, "library_photo");
export const addLibraryPhoto = (memberId: MemberId, file: { bytes: Uint8Array; fileName: string; mimeType: string }, now: Date = new Date()) => addOwn(memberId, "library_photo", file, now);
export async function loadLibraryPhoto(memberId: MemberId, recordId: string): Promise<{ info: LibraryPhotoInfo; bytes: Buffer }> {
  const rec = await findOwn(memberId, recordId, "library_photo");
  return { info: toResumeInfo(rec), bytes: await loadStored(rec) };
}
export const deleteLibraryPhoto = (memberId: MemberId, recordId: string) => deleteOwn(memberId, recordId, "library_photo");

// ---- professional photo ------------------------------------------------------------------------------------

/** FileID of each member's uploaded photo (a cache-busting version for the avatar URL). Empty when none / not set up. */
export async function photoVersions(): Promise<Partial<Record<MemberId, string>>> {
  try {
    const out: Partial<Record<MemberId, string>> = {};
    for (const f of await readAll()) if (f.kind === "photo" && !out[f.memberId]) out[f.memberId] = f.fileId;
    return out;
  } catch (err) {
    if (err instanceof SheetsError && err.code === "schema_invalid") return {};
    throw err;
  }
}

/** Sets (or replaces) the member's own photo; the previous photo's bytes are removed afterwards. */
export async function setPhoto(memberId: MemberId, file: { bytes: Uint8Array; fileName: string; mimeType: string }, now: Date = new Date()): Promise<{ version: string; uploadedAt: string }> {
  await requireTabs();
  return withWriteLock(async () => {
    const existing = (await readAll(true)).find((f) => f.memberId === memberId && f.kind === "photo");
    const fileId = await storeChatFile(file.bytes);
    const rec: MemberFile = { recordId: existing?.recordId ?? newId("pho"), memberId, kind: "photo", fileId, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.bytes.length, uploadedAt: now.toISOString() };
    try {
      if (existing) await getSheetsClient().updateValues(rowRange("memberFiles", existing.row), [serialize(rec)]);
      else await getSheetsClient().appendValues(tableRange("memberFiles"), [serialize(rec)]);
    } finally {
      invalidateTableCache();
    }
    if (existing) await deleteStoredFile(existing.fileId);
    return { version: fileId, uploadedAt: rec.uploadedAt };
  });
}

/** A member's uploaded photo for display to any signed-in teammate (avatars are shown team-wide). */
export async function loadPhoto(memberId: MemberId): Promise<{ mimeType: string; bytes: Buffer; version: string }> {
  const rec = (await readAll()).find((f) => f.memberId === memberId && f.kind === "photo");
  if (!rec) throw new DomainError("member_file_not_found", "No photo uploaded.");
  return { mimeType: rec.mimeType, bytes: await loadStored(rec), version: rec.fileId };
}

async function loadStored(rec: MemberFile): Promise<Buffer> {
  try {
    return await loadChatFile(rec.fileId, rec.sizeBytes);
  } catch (err) {
    if (err instanceof DomainError && err.code === "chat_file_not_found") throw new DomainError("member_file_not_found", "That file is no longer available.");
    throw err;
  }
}
