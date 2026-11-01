import { htmlToText } from "../http/html";
import type { PoliteFetcher } from "../http/polite-fetch";
import type { Employment, JobCandidate } from "../types";
import type { JobSearchQuery, JobSource } from "./types";

/**
 * Himalayas (himalayas.app) free public job API: INTERNSHIPS only. Its terms allow free use without a key (20 jobs per request,
 * shared public allowance), so one request is made per scan. Every saved job keeps the source name "Himalayas" and the listing's own
 * application link. Himalayas is an aggregator, not the employer's board: eligibility for its listings is decided by
 * `evaluateJob` (job-eligibility.ts), which saves one only as "not verified" when the degree / graduation year is not stated and
 * every other rule is met. Full-time listings are never read from here.
 */
const API = "https://himalayas.app/jobs/api/search";
/** Queries cycled one per scan: open to applicants in India, and worldwide-friendly. */
const QUERIES = ["country=IN&employment_type=Intern", "worldwide=true&employment_type=Intern"];
const DEFAULT_PAGES = 7;
const PER_PAGE = 20;
const TEXT_CHARS = 8000;

interface HimalayasJob {
  title?: string;
  excerpt?: string;
  companyName?: string;
  employmentType?: string;
  minSalary?: number | null;
  maxSalary?: number | null;
  salaryPeriod?: string | null;
  currency?: string | null;
  seniority?: string[];
  locationRestrictions?: string[];
  description?: string;
  pubDate?: number | string;
  expiryDate?: number | string | null;
  applicationLink?: string;
  guid?: string;
}

const iso = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return undefined;
};

const employmentOf = (s: string | undefined): Employment | undefined => (!s ? undefined : /intern/i.test(s) ? "internship" : /part/i.test(s) ? "part_time" : /contract|freelance/i.test(s) ? "contract" : /full/i.test(s) ? "full_time" : undefined);

/** One Himalayas posting as a candidate; null when it has no genuine https application link. */
export function himalayasCandidate(x: HimalayasJob): JobCandidate | null {
  const link = x.applicationLink || x.guid;
  if (!x.title || !x.companyName || !link || !/^https:\/\//i.test(link)) return null;
  const restrictions = x.locationRestrictions ?? [];
  const seniority = x.seniority ?? [];
  const period = x.salaryPeriod ?? "annual";
  const factor = period === "weekly" ? 52 / 12 : period === "fortnightly" ? 26 / 12 : 1;
  const salaryPeriod = period === "hourly" ? ("hour" as const) : period === "monthly" || period === "weekly" || period === "fortnightly" ? ("month" as const) : ("year" as const);
  const postedAt = iso(x.pubDate);
  const expiresAt = iso(x.expiryDate);
  return {
    source: "Himalayas", ...(x.guid ? { sourceId: x.guid } : {}), companyName: x.companyName.trim(), title: x.title.trim(), url: link,
    // An empty restriction list means open to applicants anywhere.
    location: restrictions.length ? restrictions.join(", ") : "Worldwide", remote: true, workplace: "remote",
    ...(employmentOf(x.employmentType) ? { employment: employmentOf(x.employmentType)! } : {}),
    ...(postedAt ? { postedAt } : {}), ...(expiresAt ? { expiresAt } : {}),
    // Only when the source labels the listing for entry-level applicants alone (a talent pool open to all levels does not count).
    ...(seniority.length > 0 && seniority.every((s) => /entry|intern|junior/i.test(s)) ? { entryLevel: true } : {}),
    description: htmlToText(`${x.excerpt ?? ""}\n${x.description ?? ""}`).slice(0, TEXT_CHARS),
    ...((x.minSalary || x.maxSalary) && x.currency ? { salary: { ...(x.minSalary ? { min: x.minSalary * factor } : {}), ...(x.maxSalary ? { max: x.maxSalary * factor } : {}), currency: x.currency.toUpperCase(), period: salaryPeriod } } : {}),
  };
}

export function createHimalayasSource(fetcher: PoliteFetcher): JobSource {
  let pages = DEFAULT_PAGES;
  return {
    id: "himalayas",
    async findCompanyJobs() {
      return [];
    },
    async searchJobs(query: JobSearchQuery): Promise<JobCandidate[]> {
      if (query.employment !== "internship") return []; // the exception is for internships only
      const slot = query.cursor ?? Math.floor(Date.now() / 300_000);
      const q = QUERIES[slot % QUERIES.length];
      const page = (Math.floor(slot / QUERIES.length) % pages) + 1;
      const body = await fetcher.getJson<{ jobs?: HimalayasJob[]; totalCount?: number }>(`${API}?${q}&sort=recent&page=${page}`, "himalayas");
      if (body?.totalCount) pages = Math.max(1, Math.min(DEFAULT_PAGES, Math.ceil(body.totalCount / PER_PAGE)));
      return (body?.jobs ?? []).map(himalayasCandidate).filter((j): j is JobCandidate => Boolean(j)).filter((j) => !query.accept || query.accept(j));
    },
  };
}
