import { protectedRoute } from "@/lib/api/protected-route";
import { ok } from "@/lib/api/responses";
import { getDueFollowUps } from "@/lib/google-sheets/follow-up-service";

/** The signed-in member's own follow-up questions that are due now. Eligibility is computed on the server. */
export const GET = protectedRoute(async ({ memberId }) => ok(await getDueFollowUps(memberId)));
