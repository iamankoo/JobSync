import { protectedRoute } from "@/lib/api/protected-route";
import { ok, readJsonBody } from "@/lib/api/responses";
import { draftAfterConnectionCreated } from "@/lib/gmail/connection-draft";
import { createConnection, listConnections } from "@/lib/google-sheets/connections-service";
import { createConnectionSchema } from "@/lib/validation/connections";

/** The shared connections list: every member sees every entry. */
export const GET = protectedRoute(async () => ok(await listConnections()));

/**
 * Adds a connection owned by the session member. If it has an email address, a personalised Gmail draft is then
 * created in that member's own Gmail (after the response; drafts only, never sent).
 */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    const input = createConnectionSchema.parse(await readJsonBody(req));
    const created = await createConnection(memberId, input);
    await draftAfterConnectionCreated(created);
    return ok(created, 201);
  },
  { mutates: true },
);
