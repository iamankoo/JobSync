import type { ApplicationStatus, Job } from "@/types/domain";

/** Pure helpers shared by the All Jobs and My Applications tables. Safe for client and server. */

export const PAGE_SIZE = 10;

export interface JobFilters {
  query: string;
  company: string;
  location: string;
  jobType: string;
  experience: string;
  /** Status filter value; "" means all. */
  status: string;
}

export const EMPTY_FILTERS: JobFilters = { query: "", company: "", location: "", jobType: "", experience: "", status: "" };

export function hasActiveFilters(f: JobFilters): boolean {
  return Object.values(f).some((v) => v.trim() !== "");
}

/** Text a keyword search runs against. */
function haystack(job: Job): string {
  return [job.jobRole, job.company, job.location, job.jobType, job.workMode, job.experience, job.stipendSalary, job.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Case-insensitive; every whitespace-separated term must appear somewhere (AND). */
export function matchesQuery(job: Job, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack(job);
  return terms.every((t) => text.includes(t));
}

export function filterByJobFields<T>(items: T[], getJob: (item: T) => Job, getStatus: (item: T) => ApplicationStatus, f: JobFilters): T[] {
  return items.filter((item) => {
    const job = getJob(item);
    if (!matchesQuery(job, f.query)) return false;
    if (f.company && job.company !== f.company) return false;
    if (f.location && job.location !== f.location) return false;
    if (f.jobType && job.jobType !== f.jobType) return false;
    if (f.experience && (job.experience ?? "") !== f.experience) return false;
    if (f.status) {
      const s = getStatus(item);
      if (f.status === "Applied") {
        // The personal indicator is binary: anything past "Not Applied" counts as applied.
        if (s === "Not Applied") return false;
      } else if (s !== f.status) return false;
    }
    return true;
  });
}

/** Sorted distinct non-empty values, for filter dropdowns built from real data only. */
export function distinctValues(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v && v.trim() !== ""))].sort((a, b) => a.localeCompare(b));
}

export type SortDirection = "asc" | "desc";

/** Compares optional ISO strings; missing values always sort last regardless of direction. */
export function compareOptional(a: string | undefined, b: string | undefined, dir: SortDirection): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return dir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
}

export interface Page<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  /** 1-based index of the first/last item shown (0 when empty). */
  from: number;
  to: number;
}

export function paginate<T>(items: T[], requestedPage: number, pageSize = PAGE_SIZE): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), pageCount);
  const start = (page - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return { items: slice, page, pageCount, total, from: total === 0 ? 0 : start + 1, to: start + slice.length };
}

/** Page numbers to render, with `null` marking a gap, e.g. [1, null, 4, 5, 6, null, 12]. */
export function pageWindow(page: number, pageCount: number): (number | null)[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const pages = new Set([1, pageCount, page - 1, page, page + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push(null);
    out.push(p);
  });
  return out;
}

// ---- dates ---------------------------------------------------------------

/** Whole days from `todayIso` (YYYY-MM-DD) to `deadline` (YYYY-MM-DD). Negative when past. */
export function daysUntil(deadline: string, todayIso: string): number {
  const d = Date.UTC(+deadline.slice(0, 4), +deadline.slice(5, 7) - 1, +deadline.slice(8, 10));
  const t = Date.UTC(+todayIso.slice(0, 4), +todayIso.slice(5, 7) - 1, +todayIso.slice(8, 10));
  return Math.round((d - t) / 86_400_000);
}

export type DeadlineTone = "overdue" | "urgent" | "soon" | "normal" | "none";

export function deadlineTone(deadline: string | undefined, todayIso: string): DeadlineTone {
  if (!deadline) return "none";
  const days = daysUntil(deadline, todayIso);
  if (days < 0) return "overdue";
  if (days <= 3) return "urgent";
  if (days <= 7) return "soon";
  return "normal";
}

/** "09 Oct 2026" from either a date (YYYY-MM-DD) or an ISO timestamp, in a fixed timezone so server and client agree. */
export function formatDisplayDate(value: string | undefined, timeZone: string): string {
  if (!value) return "—";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = dateOnly ? new Date(`${value}T12:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: dateOnly ? "UTC" : timeZone }).format(date);
}
