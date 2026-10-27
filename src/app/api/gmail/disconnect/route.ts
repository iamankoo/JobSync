import { protectedRoute } from "@/lib/api/protected-route";
import { ok } from "@/lib/api/responses";
import { loadGmailConfig } from "@/lib/gmail/config";
import { decryptToken } from "@/lib/gmail/crypto";
import { revokeToken } from "@/lib/gmail/oauth";
import { readGmailAccounts, updateGmailStatus } from "@/lib/gmail/store";
import { nowIso } from "@/lib/utils/time";

/** Disconnects the SIGNED-IN member's Gmail only: revokes at Google (best effort) and deletes the stored token. */
export const POST = protectedRoute(
  async ({ memberId }) => {
    const mine = (await readGmailAccounts({ fresh: true })).find((a) => a.memberId === memberId);
    if (mine?.refreshTokenEnc) {
      const cfg = loadGmailConfig();
      const token = cfg.ok ? decryptToken(mine.refreshTokenEnc, cfg.config.encryptionKey, memberId) : null;
      if (token) await revokeToken(token);
    }
    if (mine) await updateGmailStatus(memberId, "disconnected", "", nowIso(), true);
    return ok({ disconnected: true });
  },
  { mutates: true },
);
