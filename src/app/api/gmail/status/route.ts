import { MEMBER_IDS } from "@/config/members";
import { protectedRoute } from "@/lib/api/protected-route";
import { ok } from "@/lib/api/responses";
import { gmailOverview } from "@/lib/gmail/overview";

/** The signed-in member's own Gmail connection (with its address) and, for everyone else, only connected yes/no. */
export const GET = protectedRoute(async ({ memberId }) => ok(await gmailOverview(memberId, MEMBER_IDS)));
