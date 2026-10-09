import "server-only";
import type { MemberId } from "@/config/members";
import type { Application, ApplicationStatus, MyApplicationRow } from "@/types/domain";
import { nowIso } from "@/lib/utils/time";
import { canTransition, type UpdateApplicationInput } from "@/lib/validation/applications";
import { recordActivity } from "./activity-service";
import { DomainError } from "./errors";
import { withWriteLock } from "./lock";
import { appendApplication, readApplications, readApplicationsLocated, readJobs, updateApplicationRow } from "./repositories";

export async function listApplicationsForMember(memberId: MemberId): Promise<Application[]> {
  const { items } = await readApplications();
  return items.filter((a) => a.memberId === memberId);
}

/**
 * The caller's own applications joined with their jobs, newest activity first. Rows whose status
 * is "Not Applied" are not applications and are left out; rows pointing at a job that no longer
 * exists (e.g. deleted by hand in the sheet) are skipped and counted.
 */
export async function listMyApplications(memberId: MemberId): Promise<{ rows: MyApplicationRow[]; skipped: number }> {
  const [jobs, apps] = await Promise.all([readJobs(), readApplications()]);
  const byId = new Map(jobs.items.map((j) => [j.jobId, j]));
  const rows: MyApplicationRow[] = [];
  let skipped = 0;
  for (const application of apps.items) {
    if (application.memberId !== memberId || application.status === "Not Applied") continue;
    const job = byId.get(application.jobId);
    if (!job) {
      skipped += 1;
      continue;
    }
    rows.push({ job, application });
  }
  rows.sort((a, b) => b.application.lastUpdated.localeCompare(a.application.lastUpdated));
  return { rows, skipped };
}

export interface ApplicationUpdateResult {
  jobId: string;
  status: ApplicationStatus;
  /** The stored record, or null when the member is (still) implicitly "Not Applied". */
  application: Application | null;
  changed: boolean;
}

/**
 * Sets the status/stage/notes of `memberId`'s own application for `jobId`.
 * `memberId` comes from the validated session; this function only ever reads or writes the row
 * whose key is exactly (jobId, memberId), so it cannot touch another member's record.
 */
export async function setApplicationStatus(
  memberId: MemberId,
  jobId: string,
  input: UpdateApplicationInput,
  now: Date = new Date(),
): Promise<ApplicationUpdateResult> {
  const outcome = await withWriteLock(async (): Promise<ApplicationUpdateResult & { activity?: "job_applied" | "application_updated" }> => {
    const { items: jobs } = await readJobs();
    if (!jobs.some((j) => j.jobId === jobId)) {
      throw new DomainError("job_not_found", "That job does not exist.");
    }

    const { items } = await readApplicationsLocated();
    const existing = items.find((i) => i.value.jobId === jobId && i.value.memberId === memberId);
    const current: ApplicationStatus = existing?.value.status ?? "Not Applied";

    if (!canTransition(current, input.status)) {
      throw new DomainError("invalid_transition", `Cannot change status from "${current}" to "${input.status}".`, {
        from: current,
        to: input.status,
      });
    }

    // Not Applied with no record: nothing to store.
    if (!existing && input.status === "Not Applied") {
      return { jobId, status: "Not Applied", application: null, changed: false };
    }

    const prev = existing?.value;
    const notApplied = input.status === "Not Applied";
    const next: Application = {
      jobId,
      memberId,
      status: input.status,
      lastUpdated: nowIso(now),
    };
    if (!notApplied) next.appliedAt = prev?.appliedAt ?? nowIso(now);
    const stage = input.applicationStage === undefined ? prev?.applicationStage : (input.applicationStage ?? undefined);
    if (!notApplied && stage) next.applicationStage = stage;
    const notes = input.notes === undefined ? prev?.notes : (input.notes || undefined);
    if (notes) next.notes = notes;

    const unchanged =
      prev &&
      prev.status === next.status &&
      prev.applicationStage === next.applicationStage &&
      prev.notes === next.notes;
    if (unchanged) return { jobId, status: prev.status, application: prev, changed: false };

    if (existing) await updateApplicationRow(existing.row, next);
    else await appendApplication(next);

    return {
      jobId,
      status: next.status,
      application: next,
      changed: true,
      activity: current === "Not Applied" && next.status === "Applied" ? "job_applied" : "application_updated",
    };
  });

  if (outcome.changed && outcome.activity) await recordActivity(memberId, outcome.activity, jobId, now);
  const { activity: _activity, ...result } = outcome;
  void _activity;
  return result;
}
