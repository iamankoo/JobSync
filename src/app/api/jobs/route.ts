import { protectedRoute } from "@/lib/api/protected-route";
import { ok, readJsonBody } from "@/lib/api/responses";
import { createJob, listJobsForMember } from "@/lib/google-sheets/jobs-service";
import { createJobSchema } from "@/lib/validation/jobs";

/** Shared job list; each job carries only the caller's own application status. */
export const GET = protectedRoute(async ({ memberId }) => {
  const { jobs, skippedRows } = await listJobsForMember(memberId);
  return ok(jobs, 200, { skippedRows });
});

/** Adds a shared job. `addedBy` is always the session member. */
export const POST = protectedRoute(
  async ({ req, memberId }) => {
    const input = createJobSchema.parse(await readJsonBody(req));
    return ok(await createJob(memberId, input), 201);
  },
  { mutates: true },
);
