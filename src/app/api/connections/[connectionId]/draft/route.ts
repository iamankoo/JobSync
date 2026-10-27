import { protectedRoute } from "@/lib/api/protected-route";
import { ok } from "@/lib/api/responses";
import { createOwnConnectionDraft, ownDraftStatus } from "@/lib/gmail/connection-draft";
import { jobIdSchema } from "@/lib/validation/applications";

// Writing the email (Nemotron) and saving it in Gmail can take several seconds.
export const maxDuration = 60;

/** The signed-in member's draft state for one of THEIR OWN connections (403 for anyone else's). */
export const GET = protectedRoute<{ connectionId: string }>(async ({ memberId, params }) => {
  const id = jobIdSchema.parse(params.connectionId);
  return ok(await ownDraftStatus(memberId, id));
});

/**
 * "Create Gmail Draft": creates (or retries) the signed-in member's draft for one of THEIR OWN connections, in their
 * own Gmail only. Never duplicates an existing draft; never sends.
 */
export const POST = protectedRoute<{ connectionId: string }>(
  async ({ memberId, params }) => {
    const id = jobIdSchema.parse(params.connectionId);
    const result = await createOwnConnectionDraft(memberId, id);
    return result === "created"
      ? ok({ result, message: "Gmail draft created in your Gmail. Review and send it yourself." }, 201)
      : ok({ result, message: "Draft already exists." });
  },
  { mutates: true },
);
