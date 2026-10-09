"use client";

import { ExternalLink } from "lucide-react";
import { getMember } from "@/config/members";
import { Dialog } from "@/components/ui/dialog";
import { StatusBadge, TypeBadge } from "@/components/ui/badges";
import { CompanyMark } from "@/components/ui/company-mark";
import { buttonClass } from "@/components/ui/button";
import { formatDisplayDate } from "@/lib/jobs/query";
import type { ApplicationStatus, Job } from "@/types/domain";
import { DeadlineText } from "./deadline-text";
import { StatusToggle } from "./status-toggle";

interface Props {
  job: Job;
  /** The signed-in member's own status for this job. */
  status: ApplicationStatus;
  timeZone: string;
  today: string;
  busy?: boolean;
  onToggleStatus?: () => void;
  onClose: () => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 text-sm text-ink">{children}</dd>
    </div>
  );
}

export function JobDetailsDialog({ job, status, timeZone, today, busy, onToggleStatus, onClose }: Props) {
  const addedBy = getMember(job.addedBy)?.name ?? "Unknown";
  return (
    <Dialog title="Job details" onClose={onClose} wide>
      <div className="flex items-start gap-3">
        <CompanyMark name={job.company} size={44} />
        <div className="min-w-0">
          <p className="text-xl font-semibold">{job.jobRole}</p>
          <p className="text-muted">
            {job.company} • {job.location}
          </p>
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Type"><TypeBadge type={job.jobType} /></Field>
        <Field label="Work mode">{job.workMode ?? "—"}</Field>
        <Field label="Experience">{job.experience ?? "—"}</Field>
        <Field label="Stipend / Salary">{job.stipendSalary ?? "—"}</Field>
        <Field label="Deadline"><DeadlineText deadline={job.deadline} today={today} timeZone={timeZone} /></Field>
        <Field label="Added">{`${addedBy} on ${formatDisplayDate(job.addedAt, timeZone)}`}</Field>
        <Field label="Your status"><StatusBadge status={status} /></Field>
      </dl>

      {job.description && (
        <div className="mt-5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Description</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink/90">{job.description}</p>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <a href={job.jobUrl} target="_blank" rel="noopener noreferrer nofollow" className={buttonClass("primary")}>
          <ExternalLink size={16} aria-hidden /> Open job posting
        </a>
        {onToggleStatus && (
          <span className="flex items-center gap-2 text-sm text-muted">
            Your application:
            <StatusToggle status={status} jobLabel={`${job.jobRole} at ${job.company}`} busy={busy} onToggle={onToggleStatus} />
          </span>
        )}
      </div>
    </Dialog>
  );
}
