import { protectedRoute } from "@/lib/api/protected-route";
import { ok, readJsonBody } from "@/lib/api/responses";
import { setApplicationStatus } from "@/lib/google-sheets/applications-service";
import { jobIdSchema, updateApplicationSchema } from "@/lib/validation/applications";

/**
 * Updates the CALLER's own application for a job. The body is strict: a `memberId` field is
 * rejected, so identity can only come from the session.
 */
export const PUT = protectedRoute<{ jobId: string }>(
  async ({ req, memberId, params }) => {
    const jobId = jobIdSchema.parse(params.jobId);
    const input = updateApplicationSchema.parse(await readJsonBody(req));
    return ok(await setApplicationStatus(memberId, jobId, input));
  },
  { mutates: true },
);
