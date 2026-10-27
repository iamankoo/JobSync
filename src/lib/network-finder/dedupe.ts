import { normalizeJobUrl, parseHttpUrl } from "@/lib/utils/url";
import type { Connection, Job } from "@/types/domain";
import type { CompanyCandidate, JobCandidate, PersonCandidate } from "./types";

/**
 * Identity keys used to recognise the same company, person or job across sources, runs and retries.
 * Built on the existing URL normaliser (lib/utils/url) so jobs are compared exactly as the Jobs service does.
 */

const LEGAL_SUFFIX = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|gmbh|corp|corporation|co|plc|pte|sa|sas|srl|bv|ag|oy|ab|pty|s\.a)\b\.?/g;

/** Lower-case, accents removed, punctuation and legal suffixes dropped: "Acme, Inc." -> "acme". */
export function normalizeCompanyName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizePersonName(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function normalizeEmail(email: string | undefined): string | null {
  const e = email?.trim().toLowerCase();
  return e && e.includes("@") ? e : null;
}

/** Profile URLs compared without query/fragment; LinkedIn profiles also ignore case. */
export function normalizeProfileUrl(url: string | undefined): string | null {
  if (!url) return null;
  const u = parseHttpUrl(url);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|[a-z]{2})\.(?=linkedin\.com$)/, "").replace(/^www\./, "");
  const path = u.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return host.endsWith("linkedin.com") ? `${host}${path}`.toLowerCase() : `${host}${path}`;
}

export function domainOf(website: string | undefined): string | undefined {
  const u = website ? parseHttpUrl(/^https?:\/\//i.test(website) ? website : `https://${website}`) : null;
  return u ? u.hostname.toLowerCase().replace(/^www\./, "") : undefined;
}

/** Stable company identity: website domain if known, else the normalised name. */
export function companyKey(c: Pick<CompanyCandidate, "name" | "website">): string {
  const d = domainOf(c.website);
  return d ? `domain:${d}` : `name:${normalizeCompanyName(c.name)}`;
}

const nameAtCompany = (person: string, company: string) => `${normalizePersonName(person)}@${normalizeCompanyName(company)}`;

export type DuplicateReason = "email" | "profile_url" | "name_and_company";

/**
 * Everyone already in Connections (and anyone added during this run), indexed three ways:
 * email first, then profile URL, then name + company as a fallback.
 */
export class ConnectionIndex {
  /** Identity key → the ConnectionID it belongs to ("" when added without one). */
  private emails = new Map<string, string>();
  private urls = new Map<string, string>();
  private names = new Map<string, string>();

  static from(connections: readonly Connection[]): ConnectionIndex {
    const idx = new ConnectionIndex();
    // Only the person's own profile URL identifies them (OtherUrl is often the shared company website / team page).
    for (const c of connections) idx.add({ name: c.name, companyName: c.company ?? "", email: c.email, linkedinUrl: c.profileUrl }, c.connectionId);
    return idx;
  }

  private match(p: Pick<PersonCandidate, "name" | "companyName" | "email" | "linkedinUrl">): { reason: DuplicateReason; id: string } | null {
    const email = normalizeEmail(p.email);
    if (email && this.emails.has(email)) return { reason: "email", id: this.emails.get(email)! };
    const n = normalizeProfileUrl(p.linkedinUrl);
    if (n && this.urls.has(n)) return { reason: "profile_url", id: this.urls.get(n)! };
    const k = p.companyName.trim() ? nameAtCompany(p.name, p.companyName) : null;
    if (k && this.names.has(k)) return { reason: "name_and_company", id: this.names.get(k)! };
    return null;
  }

  /** Why this person is already known, or null if they are new. */
  duplicateOf(p: Pick<PersonCandidate, "name" | "companyName" | "email" | "linkedinUrl">): DuplicateReason | null {
    return this.match(p)?.reason ?? null;
  }

  /** The ConnectionID of the existing entry for this person, if any. */
  idOf(p: Pick<PersonCandidate, "name" | "companyName" | "email" | "linkedinUrl">): string | undefined {
    return this.match(p)?.id || undefined;
  }

  add(p: Pick<PersonCandidate, "name" | "companyName" | "email" | "linkedinUrl">, connectionId = ""): void {
    const email = normalizeEmail(p.email);
    if (email && !this.emails.has(email)) this.emails.set(email, connectionId);
    const n = normalizeProfileUrl(p.linkedinUrl);
    if (n && !this.urls.has(n)) this.urls.set(n, connectionId);
    if (p.companyName.trim()) {
      const k = nameAtCompany(p.name, p.companyName);
      if (!this.names.has(k)) this.names.set(k, connectionId);
    }
  }
}

const jobTitleKey = (company: string, title: string) => `${normalizeCompanyName(company)}|${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;

/**
 * Jobs already in the Jobs tab (and added this run): the posting URL exactly as the Jobs service compares
 * it, plus company + title so the same opening found at two URLs (e.g. a board and the careers page) is
 * not added twice.
 */
export class JobIndex {
  private urls = new Set<string>();
  private titles = new Set<string>();

  static from(jobs: readonly Job[]): JobIndex {
    const idx = new JobIndex();
    for (const j of jobs) idx.add({ url: j.jobUrl, companyName: j.company, title: j.jobRole });
    return idx;
  }

  duplicateOf(j: Pick<JobCandidate, "url" | "companyName" | "title">): "url" | "company_and_title" | null {
    const u = normalizeJobUrl(j.url);
    if (u && this.urls.has(u)) return "url";
    if (this.titles.has(jobTitleKey(j.companyName, j.title))) return "company_and_title";
    return null;
  }

  add(j: Pick<JobCandidate, "url" | "companyName" | "title">): void {
    const u = normalizeJobUrl(j.url);
    if (u) this.urls.add(u);
    this.titles.add(jobTitleKey(j.companyName, j.title));
  }
}
