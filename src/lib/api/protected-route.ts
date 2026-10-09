import "server-only";
import type { MemberId } from "@/config/members";
import { isSameOrigin } from "@/lib/auth/request";
import { getSession } from "@/lib/auth/session";
import { isMemberActive } from "@/lib/google-sheets/members-service";
import { ApiError, errorResponse } from "./responses";

interface RouteArgs<P> {
  req: Request;
  /** Member from the validated server-side session. The only source of identity. */
  memberId: MemberId;
  params: P;
}

/**
 * Wraps a route handler with the standard protections:
 *  1. same-origin check for state-changing methods,
 *  2. session validation (401 when missing/expired/tampered),
 *  3. the member must be Active in the Members tab (403 otherwise),
 *  4. uniform, secret-free error responses.
 */
export function protectedRoute<P = Record<string, never>>(
  handler: (args: RouteArgs<P>) => Promise<Response>,
  options: { mutates?: boolean } = {},
) {
  return async (req: Request, ctx?: { params: Promise<P> }): Promise<Response> => {
    try {
      if (options.mutates && !isSameOrigin(req)) throw new ApiError(403, "forbidden", "Cross-origin request rejected.");
      const session = await getSession();
      if (!session) throw new ApiError(401, "unauthenticated", "Please sign in.");
      if (!(await isMemberActive(session.memberId))) {
        throw new ApiError(403, "member_inactive", "This member is not active.");
      }
      const params = ctx ? await ctx.params : ({} as P);
      return await handler({ req, memberId: session.memberId, params });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
