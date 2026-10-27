import type { MemberId } from "@/config/members";
import { hasPassword, setPassword, UNLOCK_COOKIE, unlockWithPassword } from "@/lib/profile/lock-service";

export const TEST_PROFILE_PASSWORD = "test-profile-pw";

/** A `Cookie` header value that unlocks `memberId`'s Profile (sets the test password first if needed). */
export async function unlockedCookie(memberId: MemberId): Promise<string> {
  const token = (await hasPassword(memberId))
    ? await unlockWithPassword(memberId, TEST_PROFILE_PASSWORD)
    : await setPassword(memberId, TEST_PROFILE_PASSWORD, TEST_PROFILE_PASSWORD);
  return `${UNLOCK_COOKIE}=${token}`;
}
