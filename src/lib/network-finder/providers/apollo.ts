import { ProviderError } from "../errors";
import type { EnrichedPerson, PersonCandidate, QualifiedCompany } from "../types";
import type { ApolloCallContext, ContactProvider } from "./types";

/**
 * Apollo adapter (https://docs.apollo.io):
 *  - People search: POST /api/v1/mixed_people/api_search — costs NO credits; returns IDs, first names,
 *    obfuscated last names and titles only (no emails, no LinkedIn URLs).
 *  - Enrichment: POST /api/v1/people/match?id=… — costs credits (≈1 per email); returns the full name,
 *    work email + email_status, LinkedIn URL and title.
 * Auth is the `x-api-key` header, chosen per call by the account pool. The key is never logged or returned.
 * Errors: 401 → auth_failed, 403 → forbidden, 429 → rate_limited (retry-after), credit errors → quota_exhausted.
 */
const BASE = "https://api.apollo.io/api/v1";
const TIMEOUT_MS = 15_000;

/** Titles we ask Apollo for, in our persona order (it also returns similar titles). */
export const APOLLO_SEARCH_TITLES = [
  "recruiter", "technical recruiter", "talent acquisition", "head of talent", "people operations",
  "engineering manager", "hiring manager", "head of engineering", "vp engineering", "director of engineering", "head of data",
  "founder", "co-founder", "ceo", "cto",
  "software engineer", "data engineer", "machine learning engineer", "backend engineer", "full stack engineer",
] as const;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface ApolloSearchPerson {
  id?: string;
  first_name?: string;
  last_name_obfuscated?: string;
  title?: string | null;
}

interface ApolloMatchPerson {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string | null;
  email?: string | null;
  email_status?: string | null;
  linkedin_url?: string | null;
  match_confidence?: string;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** One Apollo API request with the pool-chosen key; maps failures to ProviderError. Exported for the org adapter. */
export async function apolloRequest(fetchFn: FetchLike, method: "GET" | "POST", path: string, params: [string, string][], ctx: ApolloCallContext, now: () => number = Date.now): Promise<unknown> {
  const url = `${BASE}${path}?${new URLSearchParams(params).toString()}`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method,
      headers: { "x-api-key": ctx.apiKey, "Content-Type": "application/json", Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("apollo", "unavailable", "request failed or timed out");
  }
  if (res.ok) {
    try {
      return await res.json();
    } catch {
      throw new ProviderError("apollo", "invalid_response", "response was not JSON");
    }
  }
  const retryAfter = Number(res.headers.get("retry-after"));
  const retryAt = Number.isFinite(retryAfter) && retryAfter > 0 ? now() + retryAfter * 1000 : undefined;
  const text = (await res.text().catch(() => "")).toLowerCase();
  if (res.status === 401) throw new ProviderError("apollo", "auth_failed", "API key rejected");
  if (res.status === 429) throw new ProviderError("apollo", "rate_limited", "rate limit reached", retryAt);
  if (res.status === 402 || /credit|insufficient|quota|limit exceeded/.test(text)) throw new ProviderError("apollo", "quota_exhausted", "out of credits", retryAt);
  if (res.status === 403) throw new ProviderError("apollo", "forbidden", /api_inaccessible|not included in your/.test(text) ? "this endpoint is not included in the account's Apollo plan" : "this key/plan may not use this endpoint");
  if (res.status >= 500) throw new ProviderError("apollo", "unavailable", `server error ${res.status}`);
  throw new ProviderError("apollo", "invalid_response", `unexpected status ${res.status}`);
}

export function createApolloProvider(fetchFn: FetchLike = fetch, now: () => number = Date.now): ContactProvider {
  return {
    id: "apollo",

    async searchPeople(company: QualifiedCompany, options: { limit: number }, ctx: ApolloCallContext): Promise<PersonCandidate[]> {
      if (!company.domain) return []; // without a domain Apollo cannot be asked precisely; never guess
      const params: [string, string][] = [
        ["q_organization_domains_list[]", company.domain],
        ...APOLLO_SEARCH_TITLES.map((t): [string, string] => ["person_titles[]", t]),
        ["include_similar_titles", "true"],
        ["page", "1"],
        ["per_page", String(Math.min(100, Math.max(1, options.limit)))],
      ];
      const body = (await apolloRequest(fetchFn, "POST", "/mixed_people/api_search", params, ctx, now)) as { people?: ApolloSearchPerson[] };
      if (!body || !Array.isArray(body.people)) throw new ProviderError("apollo", "invalid_response", "missing people array");
      return body.people
        .filter((p) => str(p.id) && str(p.first_name) && str(p.title))
        .map((p) => ({
          provider: "apollo",
          providerId: p.id!,
          // Search hides last names; the real name comes back from enrichment.
          name: [str(p.first_name), str(p.last_name_obfuscated)].filter(Boolean).join(" "),
          title: str(p.title)!,
          companyName: company.name,
          companyDomain: company.domain,
        }));
    },

    async enrichPerson(person: PersonCandidate, ctx: ApolloCallContext): Promise<EnrichedPerson> {
      if (!person.providerId) throw new ProviderError("apollo", "invalid_response", "person has no Apollo ID");
      // Work email only: personal emails and phone numbers are never requested.
      const body = (await apolloRequest(fetchFn, "POST", "/people/match", [["id", person.providerId], ["reveal_personal_emails", "false"], ["reveal_phone_number", "false"]], ctx, now)) as { person?: ApolloMatchPerson | null };
      const p = body?.person;
      if (!p || p.match_confidence === "none") return { ...person, emailStatus: "unavailable" };
      const name = str(p.name) ?? [str(p.first_name), str(p.last_name)].filter(Boolean).join(" ");
      const email = str(p.email);
      return {
        ...person,
        ...(name ? { name } : {}),
        ...(str(p.title) ? { title: str(p.title)! } : {}),
        ...(str(p.linkedin_url) ? { linkedinUrl: str(p.linkedin_url)! } : {}),
        ...(email ? { email } : {}),
        emailStatus: email ? (p.email_status === "verified" ? "verified" : "unverified") : "unavailable",
      };
    },
  };
}
