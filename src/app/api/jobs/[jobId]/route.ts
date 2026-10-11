import { protectedRoute } from "@/lib/api/protected-route";
import { ok, readJsonBody } from "@/lib/api/responses";
import { deleteJob, updateJob } from "@/lib/google-sheets/jobs-service";
import { jobIdSchema } from "@/lib/validation/applications";
import { createJobSchema } from "@/lib/validation/jobs";

/**
 * Edits a job's details. The body is the same strict schema as creating a job (no IDs, no
 * AddedBy). Only the member who added the job may edit it; the server checks that against the
 * stored AddedBy and the session, never against the request.
 */
export const PUT = protectedRoute<{ jobId: string }>(
  async ({ req, memberId, params }) => {
    const jobId = jobIdSchema.parse(params.jobId);
    const input = createJobSchema.parse(await readJsonBody(req));
    return ok(await updateJob(memberId, jobId, input));
  },
  { mutates: true },
);

/** Permanently deletes a job (owner only) together with the application records for it. */
export const DELETE = protectedRoute<{ jobId: string }>(
  async ({ memberId, params }) => {
    const jobId = jobIdSchema.parse(params.jobId);
    return ok(await deleteJob(memberId, jobId));
  },
  { mutates: true },
);
