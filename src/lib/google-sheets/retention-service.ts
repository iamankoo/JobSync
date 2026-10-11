import "server-only";
import { ageInDays, isExpired, RETENTION_DAYS } from "@/lib/retention/rules";
import { scrubDeletedJobReferences } from "./activity-service";
import { DomainError } from "./errors";
import { withWriteLock } from "./lock";
import { deleteTabRows, readApplicationsLocated, readJobsLocated } from "./repositories";

export interface ExpiredJobPlan {
  jobId: string;
  company: string;
  jobRole: string;
  addedAt: string;
  ageDays: number;
  /** Application rows (all members) that would be removed together with the job. */
  applicationRows: number;
}

export interface RetentionPlan {
  /** The instant used for the evaluation (ISO UTC). */
  evaluatedAt: string;
  retentionDays: number;
  totalJobs: number;
  expiredJobs: ExpiredJobPlan[];
  applicationRowsToDelete: number;
  /** Job rows that could not be read (e.g. invalid AddedAt). They are NEVER deleted. */
  unreadableJobRows: number;
}

export interface RetentionResult extends RetentionPlan {
  executed: boolean;
  deletedJobs: number;
  deletedApplicationRows: number;
}

/** Most jobs one run may delete. A larger result means something is wrong (clock, data): refuse. */
export const MAX_JOBS_PER_RUN = 100;

/** Destructive cleanup only runs when explicitly enabled in the environment. */
export function retentionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RETENTION_CLEANUP_ENABLED === "true";
}

async function plan(now: Date, fresh: boolean) {
  const [jobs, apps] = await Promise.all([readJobsLocated({ fresh }), readApplicationsLocated({ fresh })]);
  const expired = jobs.items.filter((j) => isExpired(j.value.addedAt, now));
  const expiredIds = new Set(expired.map((j) => j.value.jobId));
  const appRows = apps.items.filter((a) => expiredIds.has(a.value.jobId));

  const plan: RetentionPlan = {
    evaluatedAt: now.toISOString(),
    retentionDays: RETENTION_DAYS,
    totalJobs: jobs.items.length,
    expiredJobs: expired.map((j) => ({
      jobId: j.value.jobId,
      company: j.value.company,
      jobRole: j.value.jobRole,
      addedAt: j.value.addedAt,
      ageDays: ageInDays(j.value.addedAt, now) ?? 0,
      applicationRows: appRows.filter((a) => a.value.jobId === j.value.jobId).length,
    })),
    applicationRowsToDelete: appRows.length,
    unreadableJobRows: jobs.issues.filter((i) => i.problem.startsWith("row skipped")).length,
  };
  return { plan, jobRows: expired.map((j) => j.row), applicationRows: appRows.map((a) => a.row) };
}

/** READ-ONLY dry run: what a cleanup would delete right now. Never writes. */
export async function planRetention(now: Date = new Date()): Promise<RetentionPlan> {
  return (await plan(now, true)).plan;
}

/**
 * Permanently deletes jobs older than 30 days (from AddedAt) together with ALL application rows
 * for them (including any follow-up answers, which live on those rows), so no orphans are left.
 * Refuses unless RETENTION_CLEANUP_ENABLED=true, and refuses runs that would delete more than
 * MAX_JOBS_PER_RUN jobs. Jobs with unreadable timestamps are never touched. Activity history is kept.
 */
export async function runRetention(now: Date = new Date(), options: { env?: NodeJS.ProcessEnv; maxJobs?: number } = {}): Promise<RetentionResult> {
  if (!retentionEnabled(options.env)) {
    throw new DomainError("retention_disabled", "Retention cleanup is disabled. Review a dry run, then set RETENTION_CLEANUP_ENABLED=true.");
  }
  const maxJobs = options.maxJobs ?? MAX_JOBS_PER_RUN;

  return withWriteLock(async () => {
    const { plan: p, jobRows, applicationRows } = await plan(now, true);
    if (p.expiredJobs.length > maxJobs) {
      throw new DomainError("retention_limit", `Refusing to delete ${p.expiredJobs.length} jobs in one run (limit ${maxJobs}). Check the data and the clock.`);
    }
    if (p.expiredJobs.length === 0) return { ...p, executed: true, deletedJobs: 0, deletedApplicationRows: 0 };

    // Application rows FIRST, then the job rows (each in ONE request, highest row first). If the
    // second step fails the jobs are still expired, so the next run simply finishes the job:
    // the order can never leave application rows pointing at a deleted job.
    if (applicationRows.length > 0) await deleteTabRows("applications", applicationRows);
    await deleteTabRows("jobs", jobRows);
    const deletedApplicationRows = applicationRows.length;
    await scrubDeletedJobReferences(p.expiredJobs.map((j) => j.jobId));
    console.info(`[retention] deleted ${p.expiredJobs.length} job(s) and ${deletedApplicationRows} application row(s)`);
    return { ...p, executed: true, deletedJobs: p.expiredJobs.length, deletedApplicationRows };
  });
}
