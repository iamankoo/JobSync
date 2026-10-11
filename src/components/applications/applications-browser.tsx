"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ExternalLink, Plus, SearchX, Send } from "lucide-react";
import { cellClass, HEAD_ROW_CLASS, MobileSort, ROW_CLASS, TABLE_CLASS, TBODY_CLASS, THEAD_CLASS, TH_CLASS } from "@/components/ui/responsive-table";
import { ActionMenu } from "@/components/ui/action-menu";
import { StatusBadge, TypeBadge } from "@/components/ui/badges";
import { Button, buttonClass } from "@/components/ui/button";
import { CompanyMark } from "@/components/ui/company-mark";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { Pagination } from "@/components/ui/pagination";
import { DeadlineText } from "@/components/jobs/deadline-text";
import { FilterBar } from "@/components/jobs/filter-bar";
import { JobDetailsDialog } from "@/components/jobs/job-details-dialog";
import { SortableTh } from "@/components/jobs/sortable-th";
import type { ApplicationUpdate } from "@/lib/client/api";
import {
  compareOptional, distinctValues, EMPTY_FILTERS, filterByJobFields, formatDisplayDate, hasActiveFilters, paginate,
  type JobFilters, type SortDirection,
} from "@/lib/jobs/query";
import type { MyApplicationRow } from "@/types/domain";
import { ApplicationUpdateDialog } from "./application-update-dialog";

type SortKey = "appliedAt" | "deadline";

interface Props {
  rows: MyApplicationRow[];
  timeZone: string;
  today: string;
  /** Applications ignored because their job no longer exists in the sheet. */
  skipped?: number;
}

const STATUS_FILTER_OPTIONS = ["Applied", "In Progress", "Interview", "Offer", "Rejected"];

/** The signed-in member's own applications. No charts here by design. */
export function ApplicationsBrowser({ rows: initialRows, timeZone, today, skipped = 0 }: Props) {
  const [rows, setRows] = useState(initialRows);
  const [filters, setFilters] = useState<JobFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDirection }>({ key: "appliedAt", dir: "desc" });
  const [page, setPage] = useState(1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  // Fresh data from the background refresh replaces the list.
  const [seenRows, setSeenRows] = useState(initialRows);
  if (initialRows !== seenRows) {
    setSeenRows(initialRows);
    setRows(initialRows);
  }

  const options = useMemo(
    () => ({
      companies: distinctValues(rows.map((r) => r.job.company)),
      locations: distinctValues(rows.map((r) => r.job.location)),
      jobTypes: distinctValues(rows.map((r) => r.job.jobType)),
      experiences: distinctValues(rows.map((r) => r.job.experience)),
      statuses: STATUS_FILTER_OPTIONS,
    }),
    [rows],
  );

  const sorted = useMemo(() => {
    const filtered = filterByJobFields(rows, (r) => r.job, (r) => r.application.status, filters).filter(
      // "Applied" here means exactly that status; the generic filter treats it as "any applied".
      (r) => filters.status !== "Applied" || r.application.status === "Applied",
    );
    return [...filtered].sort((a, b) =>
      sort.key === "deadline"
        ? compareOptional(a.job.deadline, b.job.deadline, sort.dir)
        : compareOptional(a.application.appliedAt, b.application.appliedAt, sort.dir),
    );
  }, [rows, filters, sort]);

  const view = paginate(sorted, page);
  const editing = rows.find((r) => r.job.jobId === editingId) ?? null;
  const details = rows.find((r) => r.job.jobId === detailsId) ?? null;

  function changeFilters(patch: Partial<JobFilters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }
  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "deadline" ? "asc" : "desc" }));
    setPage(1);
  }

  function onSaved(result: ApplicationUpdate) {
    const row = rows.find((r) => r.job.jobId === result.jobId);
    setEditingId(null);
    if (!row) return;
    const label = `${row.job.jobRole} at ${row.job.company}`;
    if (!result.application || result.application.status === "Not Applied") {
      setRows((prev) => prev.filter((r) => r.job.jobId !== result.jobId));
      setNotice({ kind: "success", text: `"${label}" moved back to Not Applied and removed from My Applications.` });
      return;
    }
    const application = result.application;
    setRows((prev) => prev.map((r) => (r.job.jobId === result.jobId ? { ...r, application } : r)));
    setNotice({ kind: "success", text: `Updated "${label}": ${application.status}.` });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">My Applications</h1>
          <p className="mt-1 text-muted">Track and manage all the jobs you&apos;ve applied to</p>
        </div>
        <Link href="/add-job" className={buttonClass("primary", "px-5 py-3")}>
          <Plus size={18} aria-hidden /> Add New Job
        </Link>
      </div>

      <Notice notice={notice} onDismiss={() => setNotice(null)} />
      {skipped > 0 && (
        <p className="text-sm text-amber-300">
          {skipped} application{skipped === 1 ? " was" : "s were"} hidden because the job no longer exists in the spreadsheet.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState icon={Send} title="No applications yet" message="Jobs you mark as applied show up here, where you can track each stage and keep notes. Your applications are private to you.">
          <Link href="/all-jobs" className={buttonClass("primary")}>Browse All Jobs</Link>
        </EmptyState>
      ) : (
        <>
          <FilterBar
            filters={filters}
            options={options}
            searchLabel="Search your applications"
            searchPlaceholder="Search your applications…"
            onChange={changeFilters}
            onReset={() => changeFilters(EMPTY_FILTERS)}
            canReset={hasActiveFilters(filters)}
          />

          {sorted.length === 0 ? (
            <EmptyState icon={SearchX} title="No applications match your search" message="Try different keywords or clear the filters.">
              <Button onClick={() => changeFilters(EMPTY_FILTERS)}>Reset filters</Button>
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
                  { value: "appliedAt:desc", label: "Most recently applied" },
                  { value: "appliedAt:asc", label: "Earliest applied" },
                  { value: "deadline:asc", label: "Deadline, soonest first" },
                  { value: "deadline:desc", label: "Deadline, latest first" },
                ]}
              />
              <div className="relative overflow-x-auto">
                <table role="table" className={TABLE_CLASS}>
                  <caption className="sr-only">Your applications</caption>
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
                      <SortableTh label="Applied On" active={sort.key === "appliedAt"} direction={sort.dir} onSort={() => toggleSort("appliedAt")} />
                      <SortableTh label="Deadline" active={sort.key === "deadline"} direction={sort.dir} onSort={() => toggleSort("deadline")} />
                      <th role="columnheader" scope="col" className={TH_CLASS}>Actions</th>
                    </tr>
                  </thead>
                  <tbody role="rowgroup" className={TBODY_CLASS}>
                    {view.items.map(({ job, application }, i) => {
                      const label = `${job.jobRole} at ${job.company}`;
                      return (
                        <tr role="row" key={job.jobId} className={ROW_CLASS}>
                          <td role="cell" data-label="#" className={cellClass("text-muted", "index")}>{view.from + i}</td>
                          <td role="cell" data-label="Job Title" className={cellClass("font-medium", "title")}>
                            <button type="button" onClick={() => setDetailsId(job.jobId)} className="text-left hover:text-electric-soft hover:underline">
                              {job.jobRole}
                            </button>
                          </td>
                          <td role="cell" data-label="Company" className={cellClass("")}>
                            <span className="flex items-center gap-2"><CompanyMark name={job.company} />{job.company}</span>
                          </td>
                          <td role="cell" data-label="Location" className={cellClass("")}>{job.location}</td>
                          <td role="cell" data-label="Type" className={cellClass("")}><TypeBadge type={job.jobType} /></td>
                          <td role="cell" data-label="Experience" className={cellClass("whitespace-nowrap")}>{job.experience ?? "—"}</td>
                          <td role="cell" data-label="Stipend / Salary" className={cellClass("whitespace-nowrap")}>{job.stipendSalary ?? "—"}</td>
                          <td role="cell" data-label="Status" className={cellClass("")}>
                            <StatusBadge status={application.status} />
                            {application.applicationStage && <span className="mt-1 block text-xs text-muted">{application.applicationStage}</span>}
                          </td>
                          <td role="cell" data-label="Applied on" className={cellClass("whitespace-nowrap")}>{formatDisplayDate(application.appliedAt, timeZone)}</td>
                          <td role="cell" data-label="Deadline" className={cellClass("")}><DeadlineText deadline={job.deadline} today={today} timeZone={timeZone} /></td>
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
                                  { label: "Update status", onSelect: () => setEditingId(job.jobId) },
                                  { label: "View details", onSelect: () => setDetailsId(job.jobId) },
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
                summary={`Showing ${view.from}–${view.to} of ${view.total} application${view.total === 1 ? "" : "s"}${view.total !== rows.length ? ` (filtered from ${rows.length})` : ""}`}
              />
            </div>
          )}
        </>
      )}

      {editing && <ApplicationUpdateDialog row={editing} onClose={() => setEditingId(null)} onSaved={onSaved} />}
      {details && (
        <JobDetailsDialog job={details.job} status={details.application.status} timeZone={timeZone} today={today} onClose={() => setDetailsId(null)} />
      )}
    </div>
  );
}
