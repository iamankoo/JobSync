import type { CompanyCandidate, CompanySourceId, EnrichedPerson, JobCandidate, PersonCandidate, QualifiedCompany } from "../types";

/**
 * Provider contracts. Real adapters (YC, Wellfound, Apollo, job sources) and test mocks implement these.
 * Rules for every implementation:
 *  - return only data the provider actually returned; on failure throw ProviderError (never invent data);
 *  - respect the provider's terms, robots rules, logins and CAPTCHAs (never work around them);
 *  - never log or return credentials.
 */

export interface DiscoverQuery {
  /** Upper bound on the employee count to ask for (the qualifier still checks every result). */
  maxEmployees: number;
  /** Countries to look in (ISO alpha-2). */
  countries: readonly string[];
  limit: number;
  /** Opaque paging cursor returned by the previous call, if any. */
  cursor?: string;
  /** Epoch ms by which the run must wrap up; slow sources stop early and return the cursor reached so far. */
  deadline?: number;
}

export interface DiscoverPage {
  companies: CompanyCandidate[];
  /** Pass back to get the next page; undefined when there is nothing more. */
  nextCursor?: string;
}

export interface CompanySource {
  readonly id: CompanySourceId;
  discover(query: DiscoverQuery): Promise<DiscoverPage>;
}

/** Per-call credentials chosen by the Apollo account pool. */
export interface ApolloCallContext {
  apiKey: string;
}

/** Contact discovery + enrichment (Apollo). Each call costs quota on the chosen account. */
export interface ContactProvider {
  readonly id: string;
  /** People at the company whose titles may matter to us (recruiting, hiring, leadership, engineering). */
  searchPeople(company: QualifiedCompany, options: { limit: number }, ctx: ApolloCallContext): Promise<PersonCandidate[]>;
  /** Adds contact details (email, profile URLs) the provider actually has for this person. */
  enrichPerson(person: PersonCandidate, ctx: ApolloCallContext): Promise<EnrichedPerson>;
}

/** What a free contact source found for one company. */
export interface ContactFinding {
  /** Named people with only the details published for them (email status "public" when an address was published). */
  people: EnrichedPerson[];
  /** Every address published on the company's pages at its own domain (pattern evidence; generic inboxes included). */
  publishedEmails: { email: string; sourceUrl: string }[];
  /** Pages actually read. */
  pages: string[];
  /** The company's own host(s) the pages were on (more than one after a redirect, e.g. a rebrand). */
  hosts?: string[];
}

/** A FREE contact source (public company pages, the company's public hiring post). No credits involved. */
export interface ContactFinder {
  readonly id: string;
  findPeople(company: QualifiedCompany): Promise<ContactFinding>;
}

/** A person as an extractor read them off a page (checked against the page text before use). */
export interface ExtractedPerson {
  name: string;
  title: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  /** Which of the given pages they were found on. */
  pageUrl: string;
}

export interface ExtractPage {
  url: string;
  text: string;
  links: { href: string; text: string }[];
}

/** Reads named people + titles off public page text (Nemotron). Must only return what the pages say. */
export interface PeopleExtractor {
  readonly id: string;
  extractPeople(input: { companyName: string; pages: readonly ExtractPage[] }): Promise<ExtractedPerson[]>;
}

export interface JobSearchQuery {
  /** Free-text role keywords (from the target profiles). */
  keywords: readonly string[];
  employment: "internship" | "full_time";
  limit: number;
  /** Companies already known to us, whose OFFICIAL boards a board source searches. */
  companies?: readonly QualifiedCompany[];
  /** Epoch ms by which the run must wrap up. */
  deadline?: number;
  /**
   * Cheap pre-check on a listing as the board shows it (title, location): details (description, posted pay) are fetched
   * only for listings it accepts, so the run's time goes to jobs that can still qualify.
   */
  accept?: (job: JobCandidate) => boolean;
  /** Counts what the source saw, for the daily funnel report. */
  stats?: SearchStats;
}

export interface SearchStats {
  /** Boards read this run / boards that could not be read. */
  boardsRead: number;
  boardsFailed: number;
  /** Listings returned by the boards read (before any filtering). */
  listed: number;
}

export interface JobSource {
  readonly id: string;
  /** Open postings of one company (e.g. its public careers board). */
  findCompanyJobs(company: QualifiedCompany): Promise<JobCandidate[]>;
  /** Broader search across companies, if the source supports it. */
  searchJobs?(query: JobSearchQuery): Promise<JobCandidate[]>;
}
