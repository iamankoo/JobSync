import { classifyEmployment } from "../roles";
import { extractLinks, htmlToText } from "../http/html";
import type { PoliteFetcher } from "../http/polite-fetch";
import { isRemote } from "../geo";
import type { Employment, JobCandidate, QualifiedCompany } from "../types";
import type { JobSearchQuery, JobSource } from "./types";

/**
 * FREE job sources, all public APIs that allow programmatic use:
 *  - Greenhouse Job Board API and Lever Postings API, for a company whose OWN website / careers link points to
 *    its board (we never guess a board name from the company name, so another company's jobs cannot slip in);
 *  - Remote OK API (attribution: every saved job links to its Remote OK page and names Remote OK as the source);
 *  - Arbeitnow Job Board API.
 */

const GREENHOUSE = /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/i;
const LEVER = /jobs\.lever\.co\/([A-Za-z0-9_.-]+)/i;

export type Board = { kind: "greenhouse" | "lever"; token: string };

export function boardFromUrl(url: string): Board | null {
  const g = GREENHOUSE.exec(url);
  if (g && !/^(embed|v1)$/i.test(g[1])) return { kind: "greenhouse", token: g[1].toLowerCase() };
  const l = LEVER.exec(url);
  if (l) return { kind: "lever", token: l[1].toLowerCase() };
  return null;
}

interface GreenhouseJob {
  id?: number;
  title?: string;
  absolute_url?: string;
  location?: { name?: string };
  updated_at?: string;
}
interface LeverPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  categories?: { location?: string; commitment?: string };
  workplaceType?: string;
  createdAt?: number;
}

const commitment = (c: string | undefined): Employment | undefined =>
  !c ? undefined : /intern/i.test(c) ? "internship" : /part/i.test(c) ? "part_time" : /contract|freelance|temporary/i.test(c) ? "contract" : /full/i.test(c) ? "full_time" : undefined;

export function createCompanyBoardSource(fetcher: PoliteFetcher): JobSource {
  async function boardFor(company: QualifiedCompany): Promise<Board | null> {
    if (company.careersUrl) {
      const b = boardFromUrl(company.careersUrl);
      if (b) return b;
    }
    // Links on the company's own homepage / careers page (pages are cached for the run).
    for (const url of [company.careersUrl, company.website].filter((u): u is string => Boolean(u))) {
      try {
        const r = await fetcher.get(url, "company-board");
        if (r.status !== 200) continue;
        for (const l of extractLinks(r.text, r.url)) {
          const b = boardFromUrl(l.href);
          if (b) return b;
        }
        const embedded = boardFromUrl(r.text); // embedded board scripts
        if (embedded) return embedded;
      } catch {
        // Not reachable / not allowed: no board for this company this run.
      }
    }
    return null;
  }

  return {
    id: "company-board",
    async findCompanyJobs(company) {
      const board = await boardFor(company);
      if (!board) return [];
      if (board.kind === "greenhouse") {
        const body = await fetcher.getJson<{ jobs?: GreenhouseJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs`, "greenhouse");
        return (body?.jobs ?? [])
          .filter((j) => j.title && j.absolute_url)
          .map((j) => ({
            source: "Greenhouse", sourceId: String(j.id ?? ""), companyName: company.name, companyKey: company.key, title: j.title!.trim(), url: j.absolute_url!,
            ...(j.location?.name ? { location: j.location.name } : {}), remote: isRemote(`${j.title} ${j.location?.name ?? ""}`), ...(j.updated_at ? { postedAt: j.updated_at } : {}),
          }));
      }
      const postings = await fetcher.getJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(board.token)}?mode=json`, "lever");
      return (Array.isArray(postings) ? postings : [])
        .filter((p) => p.text && p.hostedUrl)
        .map((p) => {
          const employment = commitment(p.categories?.commitment);
          return {
            source: "Lever", ...(p.id ? { sourceId: p.id } : {}), companyName: company.name, companyKey: company.key, title: p.text!.trim(), url: p.hostedUrl!,
            ...(p.categories?.location ? { location: p.categories.location } : {}), remote: p.workplaceType === "remote" || isRemote(`${p.text} ${p.categories?.location ?? ""}`),
            ...(employment ? { employment } : {}), ...(p.createdAt ? { postedAt: new Date(p.createdAt).toISOString() } : {}),
          };
        });
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
        .map((j) => {
          const intern = /\bintern(ship)?\b/i.test(`${j.position} ${(j.tags ?? []).join(" ")}`);
          return {
            source: "Remote OK", sourceId: String(j.id ?? ""), companyName: j.company!.trim(), title: j.position!.trim(), url: j.url!,
            location: j.location?.trim() || "Remote", remote: true, employment: intern ? "internship" as const : classifyEmployment(j.position!),
            ...(j.date ? { postedAt: j.date } : {}), ...(j.description ? { description: htmlToText(j.description).slice(0, 600) } : {}),
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
        .map((j) => {
          const types = (j.job_types ?? []).join(" ");
          const employment: Employment = /intern|praktikum|working student|werkstudent/i.test(`${types} ${j.title}`) ? "internship" : classifyEmployment(j.title!, commitment(types));
          return {
            source: "Arbeitnow", ...(j.slug ? { sourceId: j.slug } : {}), companyName: j.company_name!.trim(), title: j.title!.trim(), url: j.url!,
            ...(j.location ? { location: j.location } : {}), remote: Boolean(j.remote), employment,
            ...(j.created_at ? { postedAt: new Date(j.created_at * 1000).toISOString() } : {}), ...(j.description ? { description: htmlToText(j.description).slice(0, 600) } : {}),
          };
        })
        .filter((j) => j.employment === query.employment);
    },
  };
}
