import "server-only";
import type { MemberId } from "@/config/members";
import type { Job, JobWithMyStatus } from "@/types/domain";
import { normalizeJobUrl } from "@/lib/utils/url";
import { nowIso } from "@/lib/utils/time";
import type { CreateJobInput } from "@/lib/validation/jobs";
import { recordActivity, scrubDeletedJobReferences } from "./activity-service";
import { DomainError } from "./errors";
import { newId } from "./ids";
import { withWriteLock } from "./lock";
import {
  appendJob, deleteTabRows, readApplicationsLocated, readApplications, readJobs, readJobsLocated, updateJobRow,
} from "./repositories";

export async function listJobsForMember(memberId: MemberId): Promise<{ jobs: JobWithMyStatus[]; skippedRows: number }> {
  const [jobs, apps] = await Promise.all([readJobs(), readApplications()]);
  const mine = new Map(apps.items.filter((a) => a.memberId === memberId).map((a) => [a.jobId, a]));
  const list = jobs.items
    .map((j): JobWithMyStatus => ({ ...j, myStatus: mine.get(j.jobId)?.status ?? "Not Applied", myStage: mine.get(j.jobId)?.applicationStage, myFollowUpAnswer: mine.get(j.jobId)?.followUpAnswer }))
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
    const { items } = await readJobs({ fresh: true });
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

const NOT_OWNER = "Only the member who added this job can edit or delete it.";

/**
 * Edits a job. Only the member who added it may do so (checked here, against the stored AddedBy,
 * never against anything the browser sends). JobID, AddedBy and AddedAt are immutable; the other
 * fields are replaced by `input`. The new URL must not duplicate a different job's URL.
 */
export async function updateJob(memberId: MemberId, jobId: string, input: CreateJobInput, now: Date = new Date()): Promise<Job> {
  const normalized = normalizeJobUrl(input.jobUrl);
  if (!normalized) throw new DomainError("validation_failed", "Invalid job URL.");

  const updated = await withWriteLock(async () => {
    const { items } = await readJobsLocated({ fresh: true });
    const current = items.find((i) => i.value.jobId === jobId);
    if (!current) throw new DomainError("job_not_found", "That job does not exist.");
    if (current.value.addedBy !== memberId) throw new DomainError("not_job_owner", NOT_OWNER);

    const clash = items.find((i) => i.value.jobId !== jobId && normalizeJobUrl(i.value.jobUrl) === normalized);
    if (clash) {
      throw new DomainError("duplicate_url", "This job URL has already been added.", {
        existingJobId: clash.value.jobId,
        company: clash.value.company,
        jobRole: clash.value.jobRole,
      });
    }

    const next: Job = {
      jobId,
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
      addedBy: current.value.addedBy,
      addedAt: current.value.addedAt,
    };
    await updateJobRow(current.row, next);
    return next;
  });

  await recordActivity(memberId, "job_updated", jobId, now);
  return updated;
}

/**
 * Permanently deletes a job (owner only) and then the application records for it. The job row is
 * removed first: if clean-up of application rows fails afterwards, those rows are harmless orphans
 * that every screen already ignores.
 */
export async function deleteJob(memberId: MemberId, jobId: string, now: Date = new Date()): Promise<{ jobId: string }> {
  await withWriteLock(async () => {
    const { items } = await readJobsLocated({ fresh: true });
    const current = items.find((i) => i.value.jobId === jobId);
    if (!current) throw new DomainError("job_not_found", "That job does not exist.");
    if (current.value.addedBy !== memberId) throw new DomainError("not_job_owner", NOT_OWNER);

    await deleteTabRows("jobs", [current.row]);

    try {
      const apps = await readApplicationsLocated({ fresh: true });
      const rows = apps.items.filter((a) => a.value.jobId === jobId).map((a) => a.row);
      if (rows.length > 0) await deleteTabRows("applications", rows);
    } catch (err) {
      console.error("[sheets] job deleted but its application rows could not be removed", err instanceof Error ? err.name : typeof err);
    }
  });

  // Keep the history row but drop its reference to the deleted job (no orphaned JobIDs in Activity).
  await scrubDeletedJobReferences([jobId]);
  await recordActivity(memberId, "job_deleted", undefined, now);
  return { jobId };
}
