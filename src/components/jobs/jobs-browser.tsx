"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Briefcase, Clock, ExternalLink, FileText, Plus, Send, SearchX } from "lucide-react";
import { ActionMenu } from "@/components/ui/action-menu";
import { TypeBadge } from "@/components/ui/badges";
import { buttonClass, Button } from "@/components/ui/button";
import { CompanyMark } from "@/components/ui/company-mark";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { Pagination } from "@/components/ui/pagination";
import { updateApplication } from "@/lib/client/api";
import {
  compareOptional, distinctValues, EMPTY_FILTERS, filterByJobFields, formatDisplayDate, hasActiveFilters, paginate,
  type JobFilters, type SortDirection,
} from "@/lib/jobs/query";
import { countStatuses } from "@/lib/jobs/stats";
import type { JobWithMyStatus } from "@/types/domain";
import { DeadlineText } from "./deadline-text";
import { FilterBar } from "./filter-bar";
import { JobDetailsDialog } from "./job-details-dialog";
import { SortableTh } from "./sortable-th";
import { StatusToggle } from "./status-toggle";

type SortKey = "addedAt" | "deadline";

interface Props {
  jobs: JobWithMyStatus[];
  initialQuery?: string;
  timeZone: string;
  today: string;
  /** Spreadsheet rows ignored because they were incomplete or invalid. */
  skippedRows?: number;
}

const STATUS_FILTER_OPTIONS = ["Applied", "Not Applied", "In Progress", "Interview", "Offer", "Rejected"];

function SummaryCard({ label, value, tone, icon: Icon }: { label: string; value: number; tone: string; icon: typeof Briefcase }) {
  return (
    <div className={`flex items-center gap-4 rounded-xl border p-4 ${tone}`}>
      <span className="grid h-12 w-12 place-items-center rounded-xl bg-white/10">
        <Icon size={24} aria-hidden />
      </span>
      <div>
        <p className="text-3xl font-bold leading-none">{value}</p>
        <p className="mt-1 text-sm text-ink/80">{label}</p>
      </div>
    </div>
  );
}

export function JobsBrowser({ jobs: initialJobs, initialQuery = "", timeZone, today, skippedRows = 0 }: Props) {
  const [jobs, setJobs] = useState(initialJobs);
  const [filters, setFilters] = useState<JobFilters>({ ...EMPTY_FILTERS, query: initialQuery });
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDirection }>({ key: "addedAt", dir: "desc" });
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const options = useMemo(
    () => ({
      companies: distinctValues(jobs.map((j) => j.company)),
      locations: distinctValues(jobs.map((j) => j.location)),
      jobTypes: distinctValues(jobs.map((j) => j.jobType)),
      experiences: distinctValues(jobs.map((j) => j.experience)),
      statuses: STATUS_FILTER_OPTIONS,
    }),
    [jobs],
  );

  const counts = useMemo(() => countStatuses(jobs.map((j) => j.myStatus)), [jobs]);

  const sorted = useMemo(() => {
    const filtered = filterByJobFields(jobs, (j) => j, (j) => j.myStatus, filters);
    return [...filtered].sort((a, b) =>
      sort.key === "deadline" ? compareOptional(a.deadline, b.deadline, sort.dir) : compareOptional(a.addedAt, b.addedAt, sort.dir),
    );
  }, [jobs, filters, sort]);

  const view = paginate(sorted, page);
  const selected = jobs.find((j) => j.jobId === selectedId) ?? null;

  function changeFilters(patch: Partial<JobFilters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "deadline" ? "asc" : "desc" }));
    setPage(1);
  }

  async function toggleApplied(job: JobWithMyStatus) {
    if (busyId) return;
    const target = job.myStatus === "Not Applied" ? "Applied" : job.myStatus === "Applied" ? "Not Applied" : null;
    if (!target) return;
    setBusyId(job.jobId);
    const res = await updateApplication(job.jobId, { status: target });
    setBusyId(null);
    if (!res.ok) {
      setNotice({ kind: "error", text: `Could not update "${job.jobRole} at ${job.company}": ${res.message}` });
      return;
    }
    setJobs((prev) => prev.map((j) => (j.jobId === job.jobId ? { ...j, myStatus: res.data.status } : j)));
    setNotice({ kind: "success", text: `"${job.jobRole} at ${job.company}" marked as ${res.data.status}.` });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">All Jobs</h1>
          <p className="mt-1 text-muted">Explore all job opportunities</p>
        </div>
        <Link href="/add-job" className={buttonClass("primary", "px-5 py-3")}>
          <Plus size={18} aria-hidden /> Add New Job
        </Link>
      </div>

      <section aria-label="Your job summary" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Total Jobs" value={counts.total} icon={Briefcase} tone="border-blue-500/40 bg-gradient-to-br from-blue-600/25 to-navy-900" />
        <SummaryCard label="Applied" value={counts.applied} icon={Send} tone="border-emerald-500/40 bg-gradient-to-br from-emerald-600/25 to-navy-900" />
        <SummaryCard label="Pending" value={counts.pending} icon={Clock} tone="border-amber-500/40 bg-gradient-to-br from-amber-600/25 to-navy-900" />
        <SummaryCard label="Not Applied" value={counts.notApplied} icon={FileText} tone="border-violet-500/40 bg-gradient-to-br from-violet-600/25 to-navy-900" />
      </section>

      <Notice notice={notice} onDismiss={() => setNotice(null)} />
      {skippedRows > 0 && (
        <p className="text-sm text-amber-300">
          {skippedRows} spreadsheet row{skippedRows === 1 ? " was" : "s were"} skipped because {skippedRows === 1 ? "it is" : "they are"} incomplete or invalid.
        </p>
      )}

      {jobs.length === 0 ? (
        <EmptyState icon={Briefcase} title="No jobs yet" message="Nothing has been shared with the team yet. Add a job and it will appear here for everyone.">
          <Link href="/add-job" className={buttonClass("primary")}>
            <Plus size={16} aria-hidden /> Add New Job
          </Link>
        </EmptyState>
      ) : (
        <>
          <FilterBar
            filters={filters}
            options={options}
            searchLabel="Search jobs"
            searchPlaceholder="Search jobs…"
            onChange={changeFilters}
            onReset={() => changeFilters(EMPTY_FILTERS)}
            canReset={hasActiveFilters(filters)}
          />

          {sorted.length === 0 ? (
            <EmptyState icon={SearchX} title="No jobs match your search" message="Try different keywords or clear the filters.">
              <Button variant="secondary" onClick={() => changeFilters(EMPTY_FILTERS)}>Reset filters</Button>
            </EmptyState>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line bg-navy-900/70">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1080px] text-sm">
                  <caption className="sr-only">Shared jobs with your own application status</caption>
                  <thead className="border-b border-line text-muted">
                    <tr>
                      <th scope="col" className="px-3 py-3 text-left font-medium">#</th>
                      <th scope="col" className="px-3 py-3 text-left font-medium">Job Title</th>
                      <th scope="col" className="px-3 py-3 text-left font-medium">Company</th>
                      <th scope="col" className="px-3 py-3 text-left font-medium">Location</th>
                      <th scope="col" className="px-3 py-3 text-left font-medium">Type</th>
                      <th scope="col" className="px-3 py-3 text-left font-medium">Experience</th>
                      <th scope="col" className="px-3 py-3 text-left font-medium">Stipend / Salary</th>
                      <th scope="col" className="px-3 py-3 text-left font-medium">Status</th>
                      <SortableTh label="Deadline" active={sort.key === "deadline"} direction={sort.dir} onSort={() => toggleSort("deadline")} />
                      <SortableTh label="Added On" active={sort.key === "addedAt"} direction={sort.dir} onSort={() => toggleSort("addedAt")} />
                      <th scope="col" className="px-3 py-3 text-left font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.items.map((job, i) => {
                      const label = `${job.jobRole} at ${job.company}`;
                      const canToggle = job.myStatus === "Not Applied" || job.myStatus === "Applied";
                      return (
                        <tr key={job.jobId} className="border-b border-line/60 last:border-0 hover:bg-navy-800/50">
                          <td className="px-3 py-3 text-muted">{view.from + i}</td>
                          <td className="px-3 py-3 font-medium">
                            <button type="button" onClick={() => setSelectedId(job.jobId)} className="text-left hover:text-electric-soft hover:underline">
                              {job.jobRole}
                            </button>
                          </td>
                          <td className="px-3 py-3">
                            <span className="flex items-center gap-2">
                              <CompanyMark name={job.company} />
                              {job.company}
                            </span>
                          </td>
                          <td className="px-3 py-3">{job.location}</td>
                          <td className="px-3 py-3"><TypeBadge type={job.jobType} /></td>
                          <td className="whitespace-nowrap px-3 py-3">{job.experience ?? "—"}</td>
                          <td className="whitespace-nowrap px-3 py-3">{job.stipendSalary ?? "—"}</td>
                          <td className="px-3 py-3">
                            <StatusToggle status={job.myStatus} jobLabel={label} busy={busyId === job.jobId} onToggle={() => toggleApplied(job)} />
                          </td>
                          <td className="px-3 py-3"><DeadlineText deadline={job.deadline} today={today} timeZone={timeZone} /></td>
                          <td className="whitespace-nowrap px-3 py-3">{formatDisplayDate(job.addedAt, timeZone)}</td>
                          <td className="px-3 py-3">
                            <span className="flex items-center gap-2">
                              <a
                                href={job.jobUrl}
                                target="_blank"
                                rel="noopener noreferrer nofollow"
                                aria-label={`Open job posting: ${label}`}
                                className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-navy-900 text-electric-soft transition hover:border-electric-soft"
                              >
                                <ExternalLink size={17} aria-hidden />
                              </a>
                              <ActionMenu
                                label={`More actions: ${label}`}
                                items={[
                                  { label: "View details", onSelect: () => setSelectedId(job.jobId) },
                                  {
                                    label: job.myStatus === "Not Applied" ? "Mark as applied" : "Mark as not applied",
                                    onSelect: () => toggleApplied(job),
                                    disabled: !canToggle,
                                  },
                                ]}
                              />
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={view.page}
                pageCount={view.pageCount}
                onChange={setPage}
                summary={`Showing ${view.from}–${view.to} of ${view.total} job${view.total === 1 ? "" : "s"}${view.total !== jobs.length ? ` (filtered from ${jobs.length})` : ""}`}
              />
            </div>
          )}
        </>
      )}

      {selected && (
        <JobDetailsDialog
          job={selected}
          status={selected.myStatus}
          timeZone={timeZone}
          today={today}
          busy={busyId === selected.jobId}
          onToggleStatus={() => toggleApplied(selected)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
