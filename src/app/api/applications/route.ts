import { protectedRoute } from "@/lib/api/protected-route";
import { ok } from "@/lib/api/responses";
import { listApplicationsForMember } from "@/lib/google-sheets/applications-service";

/** The caller's own applications only. */
export const GET = protectedRoute(async ({ memberId }) => ok(await listApplicationsForMember(memberId)));
