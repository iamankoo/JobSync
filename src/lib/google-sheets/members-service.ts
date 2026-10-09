import "server-only";
import type { MemberId } from "@/config/members";
import { readMembers } from "./repositories";

const TTL_MS = 30_000;
let cache: { at: number; active: Set<MemberId> } | null = null;

/**
 * A member is active only if the Members tab has a row for them with Active = TRUE.
 * Identity (name, photo, accent) always comes from src/config/members.ts; the tab only
 * carries the Active flag, so deactivating someone is a spreadsheet edit (effective within ~30 s).
 * Cached briefly to avoid a Sheets read on every write.
 */
export async function isMemberActive(memberId: MemberId, now: number = Date.now()): Promise<boolean> {
  if (!cache || now - cache.at > TTL_MS) {
    const { items } = await readMembers();
    cache = { at: now, active: new Set(items.filter((m) => m.active).map((m) => m.memberId)) };
  }
  return cache.active.has(memberId);
}

export function resetMembersCache(): void {
  cache = null;
}
