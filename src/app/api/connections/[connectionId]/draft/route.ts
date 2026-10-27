import { protectedRoute } from "@/lib/api/protected-route";
import { ok } from "@/lib/api/responses";
import { connectionDraftStatus } from "@/lib/gmail/connection-draft";
import { jobIdSchema } from "@/lib/validation/applications";

/**
 * Drafting state of one connection (shared list, so any signed-in member may see it): how many of the three
 * members' mailboxes have its draft, how many sent it, and which are skipped (Gmail not connected). Read-only —
 * drafts are created automatically by the scheduled worker, never from here.
 */
export const GET = protectedRoute<{ connectionId: string }>(async ({ params }) => {
  const id = jobIdSchema.parse(params.connectionId);
  return ok(await connectionDraftStatus(id));
});
