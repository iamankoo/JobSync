import "server-only";
import { MEMBER_IDS, type MemberId } from "@/config/members";

const WINDOW_MS = 10 * 60_000;
const MAX_UPLOADS_PER_WINDOW = 20;
const g = globalThis as unknown as { __jobsyncUploads?: Map<MemberId, number[]> };

/** Best-effort per-instance throttle so a stuck client cannot fill the sheet. */
export function allowUpload(memberId: MemberId, now = Date.now()): boolean {
  const map = (g.__jobsyncUploads ??= new Map<MemberId, number[]>());
  const recent = (map.get(memberId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_UPLOADS_PER_WINDOW) return false;
  recent.push(now);
  map.set(memberId, recent);
  return true;
}

export function resetUploadThrottleForTesting(): void {
  g.__jobsyncUploads = new Map<MemberId, number[]>(MEMBER_IDS.map((m) => [m, []]));
}
