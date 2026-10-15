import { protectedRoute } from "@/lib/api/protected-route";
import { ok, readJsonBody } from "@/lib/api/responses";
import { deleteConnection, updateConnection } from "@/lib/google-sheets/connections-service";
import { jobIdSchema } from "@/lib/validation/applications";
import { updateConnectionSchema } from "@/lib/validation/connections";

/** Edits one of the caller's own connections (any subset of fields, including the status). */
export const PUT = protectedRoute<{ connectionId: string }>(
  async ({ req, memberId, params }) => {
    const id = jobIdSchema.parse(params.connectionId);
    const input = updateConnectionSchema.parse(await readJsonBody(req));
    return ok(await updateConnection(memberId, id, input));
  },
  { mutates: true },
);

export const DELETE = protectedRoute<{ connectionId: string }>(
  async ({ memberId, params }) => {
    const id = jobIdSchema.parse(params.connectionId);
    return ok(await deleteConnection(memberId, id));
  },
  { mutates: true },
);
