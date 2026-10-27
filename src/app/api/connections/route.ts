import { protectedRoute } from "@/lib/api/protected-route";
import { ok, readJsonBody } from "@/lib/api/responses";
import { createConnection, listConnections } from "@/lib/google-sheets/connections-service";
import { createConnectionSchema } from "@/lib/validation/connections";

/** The shared connections list: every member sees every entry. */
export const GET = protectedRoute(async () => ok(await listConnections()));

/**
 * Adds a connection owned by the session member. If it has an email address, the scheduled worker drafts it into
 * all three members' own Gmail within about 10 minutes (drafts only, never sent); the save never waits for that.
 */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    const input = createConnectionSchema.parse(await readJsonBody(req));
    return ok(await createConnection(memberId, input), 201);
  },
  { mutates: true },
);
