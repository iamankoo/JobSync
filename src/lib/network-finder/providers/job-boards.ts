import { ProviderError } from "../errors";
import { classifyEmployment, matchRole } from "../roles";
import { extractLinks, htmlToText } from "../http/html";
import type { PoliteFetcher } from "../http/polite-fetch";
import { isRemote } from "../geo";
import type { Employment, JobCandidate, QualifiedCompany } from "../types";
import type { JobSearchQuery, JobSource } from "./types";

/**
 * FREE job sources, all public APIs that allow programmatic use:
 *  - Greenhouse Job Board API and Lever Postings API, for a company whose OWN website / careers link points to
 *    its board (we never guess a board name from the company name, so another company's jobs cannot slip in).
 *    These are the company's official boards, so they are the preferred source;
 *  - Remote OK API (attribution: every saved job links to its Remote OK page and names Remote OK as the source);
 *  - Arbeitnow Job Board API.
 * LinkedIn, Wellfound and similar sites are NOT read: their terms forbid automated access.
 */

const GREENHOUSE = /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/i;
const LEVER = /jobs\.lever\.co\/([A-Za-z0-9_.-]+)/i;
const ASHBY = /jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/i;

export type Board = { kind: "greenhouse" | "lever" | "ashby"; token: string };

export function boardFromUrl(url: string): Board | null {
  const g = GREENHOUSE.exec(url);
  if (g && !/^(embed|v1)$/i.test(g[1])) return { kind: "greenhouse", token: g[1].toLowerCase() };
  const l = LEVER.exec(url);
  if (l) return { kind: "lever", token: l[1].toLowerCase() };
  const a = ASHBY.exec(url);
  if (a) return { kind: "ashby", token: decodeURIComponent(a[1]) };
  return null;
}

interface AshbyJob {
  id?: string;
  title?: string;
  location?: string;
  isRemote?: boolean;
  workplaceType?: string;
  employmentType?: string;
  descriptionPlain?: string;
  jobUrl?: string;
  applyUrl?: string;
  publishedAt?: string;
  compensation?: { compensationTierSummary?: string; scrapeableCompensationSalarySummary?: string };
}

interface GreenhouseJob {
  id?: number;
  title?: string;
  absolute_url?: string;
  location?: { name?: string };
  updated_at?: string;
  /** The ORIGINAL posting date (the list carries it; `updated_at` changes on every edit and is not used as a posting date). */
  first_published?: string;
  /** Only on a single job (not in the board list): HTML-escaped description and the posted pay ranges. */
  content?: string;
  pay_input_ranges?: { min_cents?: number; max_cents?: number; currency_type?: string }[];
}
interface LeverPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  categories?: { location?: string; commitment?: string };
  workplaceType?: string;
  createdAt?: number;
  descriptionPlain?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

const LEVER_PERIOD: Record<string, "year" | "month" | "hour"> = { "per-year-salary": "year", "per-month-salary": "month", "per-hour-wage": "hour" };

const commitment = (c: string | undefined): Employment | undefined =>
  !c ? undefined : /intern/i.test(c) ? "internship" : /part/i.test(c) ? "part_time" : /contract|freelance|temporary/i.test(c) ? "contract" : /full/i.test(c) ? "full_time" : undefined;

/** Description requests per company when looking for one company's jobs (outreach), and per company when searching. */
const DETAIL_LIMIT_COMPANY = 3;
const DETAIL_LIMIT_SEARCH = 10;
/** Pay lookups per board per call, for listings that already meet every other rule. */
const PAY_LOOKUP_LIMIT = 6;
/** Description text kept per Greenhouse posting (requirements usually come last, so this is longer than the saved excerpt). */
const GREENHOUSE_TEXT_CHARS = 8000;
/** Full-time listings worth a description request: the title itself signals an early-career role (the rest are mid-level or above). */
const EARLY_CAREER_TITLE = /\b(?:intern|internship|new grad|graduate|junior|jr|entry|early career|associate|trainee|apprentice|university|campus|(?:engineer|developer|analyst|scientist)\s*(?:i|1)|sde[- ]?1)\b/i;
/**
 * Boards read per search call, per applicant-tracking system. The three systems are different hosts, so they are read in
 * parallel (each host still gets at most one request per second); consecutive calls read different slices, so the whole
 * list is swept in under an hour.
 */
const BOARDS_PER_SEARCH: Record<string, number> = { greenhouse: 12, ashby: 5, lever: 6, other: 2 };

/**
 * Searches (cron calls) needed to read every board once. The systems are read in parallel, so it is the slowest system's list
 * that sets the length of a sweep, not the total number of boards.
 */
export function sweepScans(companies: readonly Pick<QualifiedCompany, "careersUrl">[]): number {
  const sizes = new Map<string, number>();
  for (const c of companies) {
    const kind = (c.careersUrl && boardFromUrl(c.careersUrl)?.kind) || "other";
    sizes.set(kind, (sizes.get(kind) ?? 0) + 1);
  }
  let scans = 1;
  for (const [kind, n] of sizes) scans = Math.max(scans, Math.ceil(n / (BOARDS_PER_SEARCH[kind] ?? 2)));
  return scans;
}
/** Time a board search leaves for the rest of the run. */
const SEARCH_MARGIN_MS = 15_000;

type BoardCompany = Pick<QualifiedCompany, "name" | "key" | "website" | "careersUrl">;

export function createCompanyBoardSource(fetcher: PoliteFetcher): JobSource {
  async function boardFor(company: BoardCompany): Promise<Board | null> {
    if (company.careersUrl) {
      const b = boardFromUrl(company.careersUrl);
      if (b) return b;
    }
    // Links on the company's own homepage / careers page (pages are cached for the run). If the homepage has no board
    // link, its own "Careers" / "Jobs" link is followed one level.
    const pages = [company.careersUrl, company.website].filter((u): u is string => Boolean(u));
    for (let i = 0; i < pages.length && i < 4; i++) {
      try {
        const r = await fetcher.get(pages[i], "company-board");
        if (r.status !== 200) continue;
        const links = extractLinks(r.text, r.url);
        for (const l of links) {
          const b = boardFromUrl(l.href);
          if (b) return b;
        }
        const embedded = boardFromUrl(r.text); // embedded board scripts
        if (embedded) return embedded;
        const host = new URL(r.url).hostname;
        const careers = links.find((l) => /^https?:/i.test(l.href) && new URL(l.href).hostname === host && /career|jobs|join us|we.?re hiring|open roles|work with us/i.test(`${l.text} ${l.href}`) && !pages.includes(l.href));
        if (careers) pages.push(careers.href);
      } catch {
        // Not reachable / not allowed: no board for this company this run.
      }
    }
    return null;
  }

  /** A relevant Greenhouse job with its description and posted pay (one extra request; a failure leaves the job as listed). */
  async function greenhouseDetail(token: string, job: JobCandidate): Promise<JobCandidate> {
    if (!job.sourceId) return job;
    try {
      const d = await fetcher.getJson<GreenhouseJob>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(job.sourceId)}?pay_transparency=true`, "greenhouse");
      if (!d) return job;
      const description = d.content ? htmlToText(htmlToText(d.content)).slice(0, 4000) : undefined;
      const range = d.pay_input_ranges?.find((r) => r.max_cents || r.min_cents);
      const currency = range?.currency_type?.toUpperCase();
      return {
        ...job,
        ...(description ? { description } : {}),
        ...(range && currency ? { salary: { ...(range.min_cents ? { min: range.min_cents / 100 } : {}), ...(range.max_cents ? { max: range.max_cents / 100 } : {}), currency, period: "year" as const } } : {}),
      };
    } catch {
      return job;
    }
  }

  /** A board's listings as the board shows them (Greenhouse: no descriptions yet). Read once per run per company. */
  const listings = new Map<string, Promise<{ board: Board; jobs: JobCandidate[] } | null>>();
  const listBoard = (company: BoardCompany) => {
    let p = listings.get(company.key);
    if (!p) {
      p = (async () => {
        const board = await boardFor(company);
        return board ? { board, jobs: await boardJobs(company, 0, board) } : null;
      })();
      listings.set(company.key, p);
    }
    return p;
  };
  const details = new Map<string, Promise<JobCandidate>>();

  async function boardJobs(company: BoardCompany, detailLimit: number, known?: Board): Promise<JobCandidate[]> {
    const board = known ?? (await boardFor(company));
    if (!board) return [];
    if (board.kind === "greenhouse") {
      // ONE request returns every posting with its description (and original posting date): the listing text is what the
      // education / experience / fresher / remote rules are decided on, so no per-job request is needed to read it. A board too
      // large for that (or one that refuses it) falls back to the plain list plus a few detail requests below.
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs`;
      let body: { jobs?: GreenhouseJob[] } | null = null;
      try {
        body = await fetcher.getJson<{ jobs?: GreenhouseJob[] }>(`${url}?content=true`, "greenhouse");
      } catch (err) {
        if (err instanceof ProviderError && err.kind === "forbidden") throw err;
      }
      body ??= await fetcher.getJson<{ jobs?: GreenhouseJob[] }>(url, "greenhouse");
      const listed: JobCandidate[] = (body?.jobs ?? [])
        .filter((j) => j.title && j.absolute_url)
        .map((j) => ({
          source: "Greenhouse", sourceId: String(j.id ?? ""), companyName: company.name, companyKey: company.key, title: j.title!.trim(), url: j.absolute_url!,
          ...(j.location?.name ? { location: j.location.name } : {}), remote: isRemote(`${j.title} ${j.location?.name ?? ""}`), ...(j.first_published ? { postedAt: j.first_published } : {}),
          // Text only for the roles that matter (converting every posting of a 700-job board would waste the run's time).
          ...(j.content && matchRole(j.title!).relevant ? { description: htmlToText(htmlToText(j.content)).slice(0, GREENHOUSE_TEXT_CHARS) } : {}),
        }));
      // Descriptions only for the roles that matter (early-career software/data), a few per company.
      let left = detailLimit;
      const out: JobCandidate[] = [];
      for (const j of listed) {
        if (left > 0 && matchRole(j.title).relevant) {
          left -= 1;
          out.push(await greenhouseDetail(board.token, j));
        } else out.push(j);
      }
      return out;
    }
    if (board.kind === "ashby") {
      const body = await fetcher.getJson<{ jobs?: AshbyJob[] }>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.token)}?includeCompensation=true`, "ashby");
      return (body?.jobs ?? [])
        .filter((j) => j.title && (j.jobUrl || j.applyUrl))
        .map((j): JobCandidate => {
          const employment = j.employmentType ? commitment(/intern/i.test(j.employmentType) ? "intern" : j.employmentType.replace(/([a-z])([A-Z])/g, "$1 $2")) : undefined;
          const pay = j.compensation?.scrapeableCompensationSalarySummary ?? j.compensation?.compensationTierSummary;
          const wt = j.workplaceType?.toLowerCase();
          const workplace = j.isRemote || wt === "remote" ? ("remote" as const) : wt === "hybrid" ? ("hybrid" as const) : wt === "onsite" || wt === "on-site" ? ("onsite" as const) : undefined;
          return {
            source: "Ashby", ...(j.id ? { sourceId: j.id } : {}), companyName: company.name, companyKey: company.key, title: j.title!.trim(), url: (j.jobUrl ?? j.applyUrl)!,
            ...(j.location ? { location: j.location } : {}), remote: workplace === "remote" || isRemote(`${j.title} ${j.location ?? ""}`),
            ...(workplace ? { workplace } : {}), ...(employment ? { employment } : {}), ...(j.publishedAt ? { postedAt: j.publishedAt } : {}),
            ...(j.descriptionPlain ? { description: j.descriptionPlain.slice(0, 4000) } : {}), ...(pay ? { salaryText: pay.slice(0, 120) } : {}),
          };
        });
    }
    const postings = await fetcher.getJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(board.token)}?mode=json`, "lever");
    return (Array.isArray(postings) ? postings : [])
      .filter((p) => p.text && p.hostedUrl)
      .map((p): JobCandidate => {
        const employment = commitment(p.categories?.commitment);
        const period = p.salaryRange?.interval ? LEVER_PERIOD[p.salaryRange.interval] : undefined;
        const wt = p.workplaceType;
        return {
          source: "Lever", ...(p.id ? { sourceId: p.id } : {}), companyName: company.name, companyKey: company.key, title: p.text!.trim(), url: p.hostedUrl!,
          ...(p.categories?.location ? { location: p.categories.location } : {}), remote: wt === "remote" || isRemote(`${p.text} ${p.categories?.location ?? ""}`),
          ...(wt === "remote" || wt === "hybrid" ? { workplace: wt } : wt === "on-site" ? { workplace: "onsite" as const } : {}),
          ...(employment ? { employment } : {}), ...(p.createdAt ? { postedAt: new Date(p.createdAt).toISOString() } : {}),
          ...(p.descriptionPlain ? { description: p.descriptionPlain.slice(0, 4000) } : {}),
          ...(p.salaryRange?.currency && period && (p.salaryRange.max || p.salaryRange.min)
            ? { salary: { ...(p.salaryRange.min ? { min: p.salaryRange.min } : {}), ...(p.salaryRange.max ? { max: p.salaryRange.max } : {}), currency: p.salaryRange.currency, period } }
            : {}),
        };
      });
  }

  return {
    id: "company-board",
    findCompanyJobs: (company) => boardJobs(company, DETAIL_LIMIT_COMPANY),
    /**
     * Daily search over the OFFICIAL boards of companies we already know (their own website / careers page links to the
     * board): a few boards per call, a different slice each call, with the details of early-career software/data roles.
     */
    async searchJobs(query: JobSearchQuery): Promise<JobCandidate[]> {
      const companies = query.companies ?? [];
      if (!companies.length) return [];
      // Group by applicant-tracking system (a seeded or registered careers link names it; anything else is "other").
      const groups = new Map<string, QualifiedCompany[]>();
      for (const c of companies) {
        const kind = (c.careersUrl && boardFromUrl(c.careersUrl)?.kind) || "other";
        groups.set(kind, [...(groups.get(kind) ?? []), c]);
      }
      // A persisted scan counter (passed by the caller) makes the sweep resumable; the clock is only the fallback.
      const slot = query.cursor ?? Math.floor(Date.now() / 300_000);
      const readGroup = async (kind: string, group: QualifiedCompany[]): Promise<JobCandidate[]> => {
        const take = Math.min(BOARDS_PER_SEARCH[kind] ?? 2, group.length);
        const out: JobCandidate[] = [];
        for (let i = 0; i < take; i++) {
          const company = group[(slot * take + i) % group.length];
          // Only a real network read needs time: a board already listed this run (by the other kind's pass) is free. Without
          // this the full-time pass saw no boards at all once the internship pass had used the run's time (31 Oct, live logs).
          if (!listings.has(company.key) && query.deadline && Date.now() > query.deadline - SEARCH_MARGIN_MS) break;
          try {
            const listed = await listBoard(company);
            if (!listed) {
              if (query.stats) query.stats.boardsFailed += 1;
              continue;
            }
            if (query.stats) {
              query.stats.boardsRead += 1;
              query.stats.listed += listed.jobs.length;
            }
            const wanted = listed.jobs.filter((j) => classifyEmployment(j.title, j.employment) === query.employment && (!query.accept || query.accept(j)));
            // Descriptions and posted pay only for the roles that matter and can still qualify (Greenhouse lists carry neither).
            let left = DETAIL_LIMIT_SEARCH;
            let payLeft = PAY_LOOKUP_LIMIT;
            const outOfTime = () => Boolean(query.deadline && Date.now() > query.deadline - SEARCH_MARGIN_MS);
            for (const j of wanted) {
              const lookup = (): Promise<JobCandidate> => {
                let d = details.get(j.url);
                if (!d) details.set(j.url, (d = greenhouseDetail(listed.board.token, j)));
                return d;
              };
              if (listed.board.kind !== "greenhouse" || !matchRole(j.title).relevant) out.push(j);
              else if (j.description) {
                // Text already read from the list. Pay is looked up only for a listing that already meets every other rule.
                if (payLeft > 0 && !outOfTime() && query.confirm?.(j)) {
                  payLeft -= 1;
                  out.push(await lookup());
                } else out.push(j);
              } else if (left > 0 && (query.employment === "internship" || EARLY_CAREER_TITLE.test(j.title)) && !outOfTime()) {
                // Fallback for a board whose list came without descriptions: the old per-job request, early-career titles only.
                left -= 1;
                out.push(await lookup());
              } else out.push(j);
            }
          } catch {
            if (query.stats) query.stats.boardsFailed += 1; // not reachable right now: another slice is tried on the next call
          }
        }
        return out;
      };
      return (await Promise.all([...groups].map(([kind, group]) => readGroup(kind, group)))).flat();
    },
  };
}

interface RemoteOkJob {
  id?: string | number;
  company?: string;
  position?: string;
  location?: string;
  url?: string;
  tags?: string[];
  date?: string;
  description?: string;
  salary_min?: number;
  salary_max?: number;
}

export function createRemoteOkSource(fetcher: PoliteFetcher): JobSource {
  return {
    id: "remoteok",
    async findCompanyJobs() {
      return [];
    },
    async searchJobs(query: JobSearchQuery): Promise<JobCandidate[]> {
      const list = await fetcher.getJson<RemoteOkJob[]>("https://remoteok.com/api", "remoteok");
      return (Array.isArray(list) ? list.slice(1) : [])
        .filter((j) => j.company && j.position && j.url)
        .map((j): JobCandidate => {
          const intern = /\bintern(ship)?\b/i.test(`${j.position} ${(j.tags ?? []).join(" ")}`);
          return {
            source: "Remote OK", sourceId: String(j.id ?? ""), companyName: j.company!.trim(), title: j.position!.trim(), url: j.url!,
            location: j.location?.trim() || "Remote", remote: true, workplace: "remote", employment: intern ? "internship" as const : classifyEmployment(j.position!),
            ...(j.date ? { postedAt: j.date } : {}), ...(j.description ? { description: htmlToText(j.description).slice(0, 4000) } : {}),
            // Remote OK lists annual USD pay (0 = not stated).
            ...(j.salary_max || j.salary_min ? { salary: { ...(j.salary_min ? { min: j.salary_min } : {}), ...(j.salary_max ? { max: j.salary_max } : {}), currency: "USD", period: "year" as const } } : {}),
          };
        })
        .filter((j) => j.employment === query.employment);
    },
  };
}

interface ArbeitnowJob {
  slug?: string;
  company_name?: string;
  title?: string;
  description?: string;
  remote?: boolean;
  url?: string;
  job_types?: string[];
  location?: string;
  created_at?: number;
}

export function createArbeitnowSource(fetcher: PoliteFetcher): JobSource {
  return {
    id: "arbeitnow",
    async findCompanyJobs() {
      return [];
    },
    async searchJobs(query: JobSearchQuery): Promise<JobCandidate[]> {
      const body = await fetcher.getJson<{ data?: ArbeitnowJob[] }>("https://www.arbeitnow.com/api/job-board-api", "arbeitnow");
      return (body?.data ?? [])
        .filter((j) => j.company_name && j.title && j.url)
        .map((j): JobCandidate => {
          const types = (j.job_types ?? []).join(" ");
          const employment: Employment = /intern|praktikum|working student|werkstudent/i.test(`${types} ${j.title}`) ? "internship" : classifyEmployment(j.title!, commitment(types));
          return {
            source: "Arbeitnow", ...(j.slug ? { sourceId: j.slug } : {}), companyName: j.company_name!.trim(), title: j.title!.trim(), url: j.url!,
            ...(j.location ? { location: j.location } : {}), remote: Boolean(j.remote), employment,
            ...(j.remote ? { workplace: "remote" as const } : {}),
            ...(j.created_at ? { postedAt: new Date(j.created_at * 1000).toISOString() } : {}), ...(j.description ? { description: htmlToText(j.description).slice(0, 4000) } : {}),
          };
        })
        .filter((j) => j.employment === query.employment);
    },
  };
}
