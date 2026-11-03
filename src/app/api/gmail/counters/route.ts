import { isAdmin, MEMBER_IDS, type MemberId } from "@/config/members";
import { protectedRoute } from "@/lib/api/protected-route";
import { ApiError, ok } from "@/lib/api/responses";
import { countersFor } from "@/lib/gmail/sent-counter";

/**
 * GET /api/gmail/counters             the signed-in member's own Draft / Sent counts
 * GET /api/gmail/counters?member=ID   another member's counts: ADMIN ONLY (403 for everyone else)
 *
 * Draft = JobSync drafts still waiting in the member's Gmail. Sent = ONLY e-mails JobSync's automated sending workflow sent and the
 * Outreach Send Ledger recorded as confirmed (with Gmail's message id); hand-sent drafts and outside e-mails are never counted
 * (see lib/gmail/sent-counter.ts). This endpoint only READS ledgers: it does not call Gmail and cannot send or change anything.
 */
export const GET = protectedRoute(async ({ req, memberId }) => {
  const asked = new URL(req.url).searchParams.get("member");
  let target: MemberId = memberId;
  if (asked !== null && asked !== memberId) {
    if (!(MEMBER_IDS as readonly string[]).includes(asked)) throw new ApiError(400, "invalid_member", "Unknown member.");
    if (!isAdmin(memberId)) throw new ApiError(403, "forbidden", "You can only see your own counts.");
    target = asked as MemberId;
  }
  return ok({ ...(await countersFor(target)), memberId: target });
});
