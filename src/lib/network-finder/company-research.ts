import type { EmailJob } from "./email-composer";
import { decodeEntitiesForResearch, extractPageSummary } from "./http/page-summary";
import type { PoliteFetcher } from "./http/polite-fetch";
import type { JobSource } from "./providers/types";
import type { JobCandidate } from "./types";

/**
 * What the email writer may know about a company, from sources the application is allowed to read:
 * the company's OWN website (its own description of itself) and its OWN careers board (Greenhouse, Lever, Ashby).
 * Nothing is guessed: a website is accepted only when the page really names the company, a description is
 * the company's own wording, and a job exists only if the board lists it. No result means the email speaks of the
 * role family and states no company facts.
 */
export interface CompanyResearch {
  website?: string;
  /** The company's own description of what it does (its site's meta description), verbatim. */
  description?: string;
  /** Open roles on the company's own board, with the board's descriptions where it gives them. */
  jobs: JobCandidate[];
}

export interface CompanyResearchInput {
  name: string;
  website?: string;
  /** A contact's work email, whose domain is the strongest hint for the website (free-mail providers are ignored). */
  email?: string;
}

export type CompanyResearcher = (input: CompanyResearchInput) => Promise<CompanyResearch>;

const FREE_MAIL = /(^|\.)(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|proton|protonmail|aol|gmx|zoho|yandex|mail|rediffmail|msn)\.[a-z.]+$/i;
const TLDS = ["com", "ai", "io", "co", "app", "dev", "so", "tech", "xyz"];

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const stripSuffix = (s: string) => s.replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|gmbh|co)\b\.?/gi, " ").replace(/\s+/g, " ").trim();

/** A well-formed public DNS name: never an IP literal, `localhost` or an internal suffix (an email domain must not point a fetch inward). */
export function isPublicHostname(host: string): boolean {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.length > 253) return false;
  if (/^[0-9.]+$/.test(host)) return false;
  return !/\.(local|localhost|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host);
}

/** Likely website addresses for a company name, most likely first (each is VERIFIED against the page before use). */
export function websiteCandidates(name: string, email?: string): string[] {
  const out: string[] = [];
  const domain = email?.split("@")[1]?.toLowerCase();
  if (domain && !FREE_MAIL.test(domain) && isPublicHostname(domain)) out.push(`https://${domain}/`);
  const base = stripSuffix(name);
  const compact = alnum(base);
  const dashed = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // "Magic Hour AI" → magichourai, magichour (without a trailing "ai"/"labs"), magic-hour
  const short = alnum(base.replace(/\b(ai|labs?|technologies|technology|hq|app|io)\b/gi, " "));
  const slugs = [...new Set([compact, short, dashed].filter((s) => s.length >= 3))];
  for (const tld of TLDS) for (const slug of slugs) out.push(`https://${slug}.${tld}/`);
  return [...new Set(out)];
}

/** True when the page names the company (title, site name or visible text). */
export function pageNamesCompany(html: string, name: string, strict = false): boolean {
  const key = alnum(stripSuffix(name));
  if (key.length < 3) return false;
  const { title, siteName, text } = extractPageSummary(html);
  const head = alnum(`${title} ${siteName}`);
  if (head.includes(key)) return true;
  // A guessed address (no website or work email to go by) must carry the company's FULL name: a shorter match could be another company.
  if (strict) return false;
  // Also accept the name without a trailing "AI"/"Labs" word when the page text names it as a whole word.
  const short = alnum(stripSuffix(name).replace(/\b(ai|labs?|technologies|technology|hq)\b/gi, " "));
  return short.length >= 4 && alnum(text.slice(0, 3000)).includes(short) && alnum(`${title} ${siteName}`).includes(short);
}

const MAX_SITE_TRIES = 8;

export function createCompanyResearcher(fetcher: PoliteFetcher, boards: JobSource, options: { deadline?: () => number | undefined } = {}): CompanyResearcher {
  const cache = new Map<string, Promise<CompanyResearch>>();
  const timeUp = () => {
    const d = options.deadline?.();
    return d !== undefined && d - Date.now() < 12_000;
  };

  async function research(input: CompanyResearchInput): Promise<CompanyResearch> {
    const result: CompanyResearch = { jobs: [] };
    let site = input.website;
    let html: string | undefined;
    try {
      const candidates = site ? [site] : websiteCandidates(input.name, input.email).slice(0, MAX_SITE_TRIES + 20);
      let tries = 0;
      for (const url of candidates) {
        if (timeUp() || (!site && tries >= MAX_SITE_TRIES + (input.email ? 1 : 0))) break;
        tries += 1;
        try {
          const r = await fetcher.get(url, "company-research");
          if (r.status !== 200) continue;
          // The contact's work-email domain is the company's own; a guessed address needs the page to carry the full name.
          const fromEmail = Boolean(input.email) && url === candidates[0];
          if (site || pageNamesCompany(r.text, input.name, !fromEmail)) {
            site = r.url || url;
            html = r.text;
            break;
          }
        } catch {
          // Not reachable / not allowed: try the next address.
        }
      }
    } catch {
      // No website could be established: the email then states no company facts.
    }
    if (!site) return result;
    result.website = site;
    if (html) {
      const description = extractPageSummary(html).description;
      if (description) result.description = decodeEntitiesForResearch(description).slice(0, 300);
    }
    if (!timeUp()) {
      try {
        result.jobs = await boards.findCompanyJobs({ name: input.name, key: alnum(input.name), website: site } as never);
      } catch {
        result.jobs = []; // board not reachable right now: no verified job
      }
    }
    return result;
  }

  return (input) => {
    const key = `${alnum(input.name)}|${input.website ?? ""}|${input.email?.split("@")[1] ?? ""}`;
    let p = cache.get(key);
    if (!p) {
      p = research(input);
      cache.set(key, p);
    }
    return p;
  };
}

/** A researched job as the email writer's job input. */
export const asEmailJob = (j: JobCandidate): EmailJob => ({
  title: j.title,
  ...(j.description ? { description: j.description } : {}),
  internship: j.employment === "internship" || /\bintern(ship)?\b/i.test(j.title),
  ...(j.location ? { location: j.location } : {}),
  ...(j.workplace ? { workMode: j.workplace } : j.remote ? { workMode: "Remote" } : {}),
});
