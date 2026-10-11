"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Briefcase, Clock, ExternalLink, FileText, Plus, Send, SearchX } from "lucide-react";
import { cellClass, HEAD_ROW_CLASS, MobileSort, ROW_CLASS, TABLE_CLASS, TBODY_CLASS, THEAD_CLASS, TH_CLASS } from "@/components/ui/responsive-table";
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
import { countApplications, notAppliedCount } from "@/lib/counting";
import type { MemberId } from "@/config/members";
import type { Job, JobWithMyStatus } from "@/types/domain";
import { DeleteJobDialog } from "./delete-job-dialog";
import { EditJobDialog } from "./edit-job-dialog";
import { DeadlineText } from "./deadline-text";
import { FilterBar } from "./filter-bar";
import { JobDetailsDialog } from "./job-details-dialog";
import { SortableTh } from "./sortable-th";
import { StatusToggle } from "./status-toggle";

type SortKey = "addedAt" | "deadline";

interface Props {
  jobs: JobWithMyStatus[];
  /** The signed-in member (from the session). Used only to decide which edit/delete actions to show; the server enforces ownership. */
  currentMemberId: MemberId;
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

export function JobsBrowser({ jobs: initialJobs, currentMemberId, initialQuery = "", timeZone, today, skippedRows = 0 }: Props) {
  const [jobs, setJobs] = useState(initialJobs);
  const [filters, setFilters] = useState<JobFilters>({ ...EMPTY_FILTERS, query: initialQuery });
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDirection }>({ key: "addedAt", dir: "desc" });
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Fresh data from the background refresh replaces the list (unless a status change is in flight).
  const [seenJobs, setSeenJobs] = useState(initialJobs);
  if (initialJobs !== seenJobs) {
    setSeenJobs(initialJobs);
    if (!busyId) setJobs(initialJobs);
  }

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

  const counts = useMemo(() => {
    const c = countApplications(jobs.map((j) => ({ jobId: j.jobId, status: j.myStatus, applicationStage: j.myStage, followUpAnswer: j.myFollowUpAnswer })));
    return { total: jobs.length, applied: c.applied, pending: c.pending, notApplied: notAppliedCount(jobs.length, c.applied) };
  }, [jobs]);

  const sorted = useMemo(() => {
    const filtered = filterByJobFields(jobs, (j) => j, (j) => j.myStatus, filters);
    return [...filtered].sort((a, b) =>
      sort.key === "deadline" ? compareOptional(a.deadline, b.deadline, sort.dir) : compareOptional(a.addedAt, b.addedAt, sort.dir),
    );
  }, [jobs, filters, sort]);

  const view = paginate(sorted, page);
  const selected = jobs.find((j) => j.jobId === selectedId) ?? null;
  const editing = jobs.find((j) => j.jobId === editingId) ?? null;
  const deleting = jobs.find((j) => j.jobId === deletingId) ?? null;
  const isMine = (job: Job) => job.addedBy === currentMemberId;

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

  function onSaved(saved: Job) {
    setJobs((prev) => prev.map((j) => (j.jobId === saved.jobId ? { ...j, ...saved } : j)));
    setEditingId(null);
    setNotice({ kind: "success", text: `Saved changes to "${saved.jobRole} at ${saved.company}".` });
  }

  function onDeleted(jobId: string) {
    const gone = jobs.find((j) => j.jobId === jobId);
    setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
    setDeletingId(null);
    setSelectedId(null);
    setNotice({ kind: "success", text: gone ? `Deleted "${gone.jobRole} at ${gone.company}".` : "Job deleted." });
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
              <MobileSort
                value={`${sort.key}:${sort.dir}`}
                onChange={(v) => {
                  const [key, dir] = v.split(":") as [SortKey, SortDirection];
                  setSort({ key, dir });
                  setPage(1);
                }}
                options={[
                  { value: "addedAt:desc", label: "Newest added" },
                  { value: "addedAt:asc", label: "Oldest added" },
                  { value: "deadline:asc", label: "Deadline, soonest first" },
                  { value: "deadline:desc", label: "Deadline, latest first" },
                ]}
              />
              <div className="relative overflow-x-auto">
                <table role="table" className={TABLE_CLASS}>
                  <caption className="sr-only">Shared jobs with your own application status</caption>
                  <thead role="rowgroup" className={THEAD_CLASS}>
                    <tr role="row" className={HEAD_ROW_CLASS}>
                      <th role="columnheader" scope="col" className={TH_CLASS}>#</th>
                      <th role="columnheader" scope="col" className={TH_CLASS}>Job Title</th>
                      <th role="columnheader" scope="col" className={TH_CLASS}>Company</th>
                      <th role="columnheader" scope="col" className={TH_CLASS}>Location</th>
                      <th role="columnheader" scope="col" className={TH_CLASS}>Type</th>
                      <th role="columnheader" scope="col" className={TH_CLASS}>Experience</th>
                      <th role="columnheader" scope="col" className={TH_CLASS}>Stipend / Salary</th>
                      <th role="columnheader" scope="col" className={TH_CLASS}>Status</th>
                      <SortableTh label="Deadline" active={sort.key === "deadline"} direction={sort.dir} onSort={() => toggleSort("deadline")} />
                      <SortableTh label="Added On" active={sort.key === "addedAt"} direction={sort.dir} onSort={() => toggleSort("addedAt")} />
                      <th role="columnheader" scope="col" className={TH_CLASS}>Actions</th>
                    </tr>
                  </thead>
                  <tbody role="rowgroup" className={TBODY_CLASS}>
                    {view.items.map((job, i) => {
                      const label = `${job.jobRole} at ${job.company}`;
                      const canToggle = job.myStatus === "Not Applied" || job.myStatus === "Applied";
                      return (
                        <tr role="row" key={job.jobId} className={ROW_CLASS}>
                          <td role="cell" data-label="#" className={cellClass("text-muted", "index")}>{view.from + i}</td>
                          <td role="cell" data-label="Job Title" className={cellClass("font-medium", "title")}>
                            <button type="button" onClick={() => setSelectedId(job.jobId)} className="text-left hover:text-electric-soft hover:underline">
                              {job.jobRole}
                            </button>
                          </td>
                          <td role="cell" data-label="Company" className={cellClass("")}>
                            <span className="flex items-center gap-2">
                              <CompanyMark name={job.company} />
                              {job.company}
                            </span>
                          </td>
                          <td role="cell" data-label="Location" className={cellClass("")}>{job.location}</td>
                          <td role="cell" data-label="Type" className={cellClass("")}><TypeBadge type={job.jobType} /></td>
                          <td role="cell" data-label="Experience" className={cellClass("whitespace-nowrap")}>{job.experience ?? "—"}</td>
                          <td role="cell" data-label="Stipend / Salary" className={cellClass("whitespace-nowrap")}>{job.stipendSalary ?? "—"}</td>
                          <td role="cell" data-label="Status" className={cellClass("")}>
                            <StatusToggle status={job.myStatus} jobLabel={label} busy={busyId === job.jobId} onToggle={() => toggleApplied(job)} />
                          </td>
                          <td role="cell" data-label="Deadline" className={cellClass("")}><DeadlineText deadline={job.deadline} today={today} timeZone={timeZone} /></td>
                          <td role="cell" data-label="Added on" className={cellClass("whitespace-nowrap")}>{formatDisplayDate(job.addedAt, timeZone)}</td>
                          <td role="cell" data-label="Actions" className={cellClass("")}>
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
                                  ...(isMine(job)
                                    ? [
                                        { label: "Edit job", onSelect: () => setEditingId(job.jobId) },
                                        { label: "Delete job", onSelect: () => setDeletingId(job.jobId) },
                                      ]
                                    : []),
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
          onEdit={isMine(selected) ? () => { setSelectedId(null); setEditingId(selected.jobId); } : undefined}
          onDelete={isMine(selected) ? () => { setSelectedId(null); setDeletingId(selected.jobId); } : undefined}
          onClose={() => setSelectedId(null)}
        />
      )}
      {editing && <EditJobDialog job={editing} locations={options.locations} onSaved={onSaved} onClose={() => setEditingId(null)} />}
      {deleting && <DeleteJobDialog job={deleting} onDeleted={onDeleted} onClose={() => setDeletingId(null)} />}
    </div>
  );
}
