import { z } from "zod";
import { protectedRoute } from "@/lib/api/protected-route";
import { ok, readJsonBody } from "@/lib/api/responses";
import { answerFollowUp } from "@/lib/google-sheets/follow-up-service";
import { jobIdSchema } from "@/lib/validation/applications";
import { FOLLOW_UP_ANSWERS } from "@/types/domain";

/** The only thing a client may send is the answer. Identity, timestamps and eligibility are server-side. */
const answerSchema = z.strictObject({ answer: z.enum(FOLLOW_UP_ANSWERS) });

/** Answers the signed-in member's own follow-up for a job (Yes marks the stage Shortlisted). */
export const POST = protectedRoute<{ jobId: string }>(
  async ({ req, memberId, params }) => {
    const jobId = jobIdSchema.parse(params.jobId);
    const { answer } = answerSchema.parse(await readJsonBody(req));
    return ok(await answerFollowUp(memberId, jobId, answer));
  },
  { mutates: true },
);
