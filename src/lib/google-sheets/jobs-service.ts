import "server-only";
import type { MemberId } from "@/config/members";
import type { ApplicationStatus, Job } from "@/types/domain";
import { normalizeJobUrl } from "@/lib/utils/url";
import { nowIso } from "@/lib/utils/time";
import type { CreateJobInput } from "@/lib/validation/jobs";
import { recordActivity } from "./activity-service";
import { DomainError } from "./errors";
import { newId } from "./ids";
import { withWriteLock } from "./lock";
import { appendJob, readApplications, readJobs } from "./repositories";

/** A shared job plus the CALLER's own status. Other members' statuses are never included. */
export interface JobWithMyStatus extends Job {
  myStatus: ApplicationStatus;
}

export async function listJobsForMember(memberId: MemberId): Promise<{ jobs: JobWithMyStatus[]; skippedRows: number }> {
  const [jobs, apps] = await Promise.all([readJobs(), readApplications()]);
  const mine = new Map(apps.items.filter((a) => a.memberId === memberId).map((a) => [a.jobId, a.status]));
  const list = jobs.items
    .map((j): JobWithMyStatus => ({ ...j, myStatus: mine.get(j.jobId) ?? "Not Applied" }))
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  return { jobs: list, skippedRows: jobs.issues.filter((i) => i.problem.startsWith("row skipped")).length };
}

/**
 * Creates a shared job on behalf of `memberId` (taken from the session by the caller).
 * Duplicate check and append run under the write lock so concurrent requests on this
 * instance cannot both succeed for the same URL.
 */
export async function createJob(memberId: MemberId, input: CreateJobInput, now: Date = new Date()): Promise<Job> {
  const normalized = normalizeJobUrl(input.jobUrl);
  if (!normalized) throw new DomainError("validation_failed", "Invalid job URL.");

  const job = await withWriteLock(async () => {
    const { items } = await readJobs();
    const existing = items.find((j) => normalizeJobUrl(j.jobUrl) === normalized);
    if (existing) {
      throw new DomainError("duplicate_url", "This job URL has already been added.", {
        existingJobId: existing.jobId,
        company: existing.company,
        jobRole: existing.jobRole,
      });
    }
    const created: Job = {
      jobId: newId("job"),
      company: input.company,
      jobRole: input.jobRole,
      jobType: input.jobType,
      workMode: input.workMode,
      experience: input.experience,
      stipendSalary: input.stipendSalary,
      location: input.location,
      jobUrl: input.jobUrl,
      deadline: input.deadline,
      description: input.description,
      addedBy: memberId,
      addedAt: nowIso(now),
    };
    await appendJob(created);
    return created;
  });

  await recordActivity(memberId, "job_added", job.jobId, now);
  return job;
}
