import type { ApolloPool } from "../apollo-pool";
import { domainOf } from "../dedupe";
import { ProviderError } from "../errors";
import type { CompanyCandidate, CompanySourceId, JobCandidate, QualifiedCompany } from "../types";
import { apolloRequest, type FetchLike } from "./apollo";
import type { JobSource } from "./types";

/**
 * Apollo organization endpoints that need no people data:
 *  - Organization enrichment: GET /api/v1/organizations/enrich?domain=… → ID, employee estimate, country.
 *    Used to qualify companies that came from a member's manual import (or any source without size/country).
 *  - Organization job postings: GET /api/v1/organizations/{id}/job_postings → title, URL, location, dates
 *    (1 credit per page). Used to see whether a company is hiring.
 * Every call goes through the account pool (account 1 first, limits respected). Keys are never logged.
 */
interface ApolloOrg {
  id?: string;
  name?: string;
  website_url?: string | null;
  primary_domain?: string | null;
  estimated_num_employees?: number | null;
  country?: string | null;
  city?: string | null;
  short_description?: string | null;
  keywords?: string[] | null;
}

interface ApolloPosting {
  id?: string;
  title?: string;
  url?: string;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  posted_at?: string | null;
}

/** Apollo reports full country names; the qualifier works with ISO codes. */
const COUNTRY_CODES: Record<string, string> = {
  "united states": "US", usa: "US", "united kingdom": "GB", uk: "GB", singapore: "SG", canada: "CA", germany: "DE",
  "united arab emirates": "AE", uae: "AE", australia: "AU", france: "FR", italy: "IT", poland: "PL", india: "IN", brazil: "BR",
};
export const countryCode = (name: string | null | undefined): string | undefined => (name ? COUNTRY_CODES[name.trim().toLowerCase()] ?? undefined : undefined);

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function createApolloOrgProvider(pool: ApolloPool, fetchFn: FetchLike = fetch, now: () => number = Date.now) {
  /** Facts Apollo has about the company at `domain` (null if Apollo does not know it). Costs quota. */
  async function enrichByDomain(domain: string, source: CompanySourceId = "manual", sourceUrl?: string): Promise<CompanyCandidate | null> {
    const body = (await pool.call(1, (ctx) => apolloRequest(fetchFn, "GET", "/organizations/enrich", [["domain", domain]], ctx, now))) as { organization?: ApolloOrg | null };
    const o = body?.organization;
    if (!o || !str(o.id) || !str(o.name)) return null;
    const country = countryCode(o.country);
    return {
      source, sourceId: source === "manual" ? domain : o.id!, ...(sourceUrl ? { sourceUrl } : {}),
      apolloOrgId: o.id!, name: o.name!, website: str(o.website_url) ?? `https://${str(o.primary_domain) ?? domain}`,
      ...(typeof o.estimated_num_employees === "number" ? { employeeCount: o.estimated_num_employees } : {}),
      ...(country ? { countryCode: country } : {}), ...(str(o.city) ? { city: str(o.city) } : {}),
      ...(str(o.short_description) ? { description: str(o.short_description) } : {}), ...(o.keywords?.length ? { tags: o.keywords.slice(0, 20) } : {}),
    };
  }

  const jobSource: JobSource = {
    id: "apollo-job-postings",
    async findCompanyJobs(company: QualifiedCompany): Promise<JobCandidate[]> {
      let orgId = company.apolloOrgId;
      if (!orgId) {
        const domain = company.domain ?? domainOf(company.website);
        if (!domain) return [];
        orgId = (await enrichByDomain(domain))?.apolloOrgId;
        if (!orgId) return [];
      }
      const body = (await pool.call(1, (ctx) => apolloRequest(fetchFn, "GET", `/organizations/${encodeURIComponent(orgId!)}/job_postings`, [["page", "1"], ["per_page", "50"]], ctx, now))) as { organization_job_postings?: ApolloPosting[] };
      if (!body || !Array.isArray(body.organization_job_postings)) throw new ProviderError("apollo", "invalid_response", "missing organization_job_postings");
      return body.organization_job_postings
        .filter((p) => str(p.title) && str(p.url))
        .map((p) => {
          const location = [str(p.city), str(p.state), str(p.country)].filter(Boolean).join(", ");
          return {
            source: "apollo", ...(str(p.id) ? { sourceId: p.id! } : {}), companyName: company.name, companyKey: company.key,
            title: str(p.title)!, url: str(p.url)!, ...(location ? { location } : {}), remote: /remote/i.test(`${p.title} ${location}`),
            ...(str(p.posted_at) ? { postedAt: str(p.posted_at) } : {}),
          };
        });
    },
  };

  return { enrichByDomain, jobSource };
}
