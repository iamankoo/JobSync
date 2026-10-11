"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { ArrowRight, Briefcase, CheckCircle2, Clock, Lightbulb } from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { CompanyMark } from "@/components/ui/company-mark";
import { createJobRequest } from "@/lib/client/api";
import { formatDisplayDate } from "@/lib/jobs/query";
import type { Job } from "@/types/domain";
import { JobForm } from "./job-form";

// Re-exported so existing imports keep working.
export { validateJobForm } from "./job-form";

interface Props {
  recentJobs: Job[];
  /** Existing locations, offered as suggestions. */
  locations: string[];
  timeZone: string;
}

export function AddJobForm({ recentJobs, locations, timeZone }: Props) {
  const formId = useId();
  const [recent, setRecent] = useState(recentJobs);
  const topRef = useRef<HTMLDivElement>(null);

  // Pick up jobs added by other members when the page data refreshes in the background.
  const [seenRecent, setSeenRecent] = useState(recentJobs);
  if (recentJobs !== seenRecent) {
    setSeenRecent(recentJobs);
    setRecent(recentJobs);
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div ref={topRef}>
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Add New Job</h1>
            <p className="mt-1 text-muted">Share a new job opportunity with the team</p>
          </div>
          <Link href="/all-jobs" className={buttonClass("secondary")}>
            View All Jobs <ArrowRight size={16} aria-hidden />
          </Link>
        </div>

        <div className="rounded-xl border border-line bg-navy-900/70 p-5 sm:p-6">
          <div className="mb-5 flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-lg bg-blue-600/80 text-white"><Briefcase size={22} aria-hidden /></span>
            <div>
              <h2 className="font-semibold">Job Details</h2>
              <p className="text-sm text-muted">Fill in the job information below</p>
            </div>
          </div>
          <JobForm
            mode="create"
            locations={locations}
            submit={createJobRequest}
            successText={(job) => `Added "${job.jobRole}" at ${job.company}. It is now visible to everyone in All Jobs.`}
            onSuccess={(job) => {
              setRecent((r) => [job, ...r.filter((x) => x.jobId !== job.jobId)].slice(0, 5));
              topRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
            }}
          />
        </div>
      </div>

      <aside aria-label="Tips and recently added jobs" className="space-y-6">
        <section aria-labelledby={`${formId}-tips`} className="rounded-xl border border-line bg-navy-900/70 p-5">
          <h2 id={`${formId}-tips`} className="mb-4 flex items-center gap-2 text-lg font-semibold">
            <Lightbulb size={20} className="text-violet-300" aria-hidden /> Tips for Adding a Job
          </h2>
          <ul className="space-y-3 text-sm text-ink/90">
            {[
              "Use the official job link from the company website or trusted sources.",
              "Add correct and complete information.",
              "Include stipend/salary if mentioned.",
              "Duplicate links are detected automatically, so each job is added once.",
              "Made a mistake? You can edit or delete jobs you added from All Jobs.",
            ].map((tip) => (
              <li key={tip} className="flex gap-3">
                <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden />
                {tip}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby={`${formId}-recent`} className="rounded-xl border border-line bg-navy-900/70 p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id={`${formId}-recent`} className="flex items-center gap-2 text-lg font-semibold">
              <Clock size={20} className="text-violet-300" aria-hidden /> Recently Added Jobs
            </h2>
            <Link href="/all-jobs" className={buttonClass("secondary", "px-3 py-1.5")}>
              View All <ArrowRight size={14} aria-hidden />
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="text-sm text-muted">No jobs have been added yet. Jobs you add will show up here.</p>
          ) : (
            <ul className="divide-y divide-line/70">
              {recent.map((job) => (
                <li key={job.jobId} className="flex items-center gap-3 py-3">
                  <CompanyMark name={job.company} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{job.jobRole}</p>
                    <p className="truncate text-sm text-muted">{job.company} • {job.location}</p>
                  </div>
                  <span className="text-sm text-muted">{formatDisplayDate(job.addedAt, timeZone).slice(0, 6)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}
