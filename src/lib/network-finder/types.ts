/**
 * Network Finder data models. These are CANDIDATES flowing through the pipeline; the durable records
 * are the existing Connections and Jobs rows (saved through their services), plus the Network Finder's
 * own bookkeeping (company registry, queue, Apollo usage, batch ledger).
 */

/** Countries the team targets: ~70% US, ~30% the rest of this list. */
export const INTERNATIONAL_COUNTRIES = ["SG", "GB", "CA", "DE", "AE", "AU", "FR", "IT", "PL"] as const;
export type InternationalCountry = (typeof INTERNATIONAL_COUNTRIES)[number];
export type TargetCountry = "US" | InternationalCountry;
export type RegionGroup = "us" | "international";

/**
 * Where a company came from: a permitted public source (HN "Who is hiring?" via the official API, the open
 * remoteintech directory), Apollo, or a member's manual import (e.g. companies found on YC/Wellfound/LinkedIn by hand).
 */
export type CompanySourceId = "yc" | "wellfound" | "apollo" | "manual" | "hn" | "remoteintech";

/** A company as reported by a discovery source (YC, Wellfound). Only what the source actually said. */
export interface CompanyCandidate {
  source: CompanySourceId;
  /** The company's ID within that source. */
  sourceId: string;
  /** Public page for the company at the source. */
  sourceUrl?: string;
  name: string;
  website?: string;
  employeeCount?: number;
  /** ISO 3166-1 alpha-2 (the UK is "GB"). */
  countryCode?: string;
  city?: string;
  remoteFriendly?: boolean;
  /** The source says the company is hiring. */
  hiring?: boolean;
  description?: string;
  tags?: string[];
  /** Apollo's organization ID, when known (lets job postings be fetched without another lookup). */
  apolloOrgId?: string;
  /** The size as the source stated it, when it gave a band rather than a number (e.g. "11-50"); employeeCount is then the band's upper bound. */
  employeeRange?: string;
  /** Public careers page or job board link the source gave. */
  careersUrl?: string;
  /** The public text the company was found in (e.g. its HN hiring post), kept for contact discovery. */
  sourceText?: string;
  /** Where a size / country that the discovery source did not state was found (e.g. "size stated on https://x.io/about"). */
  factsSource?: string;
}

/** Smallest size band (by employee count) the company falls into. Smaller bands are preferred. */
export type SizeTier = 25 | 100 | 250;

export interface QualifiedCompany extends CompanyCandidate {
  /** Stable identity across sources and runs (website domain, else normalised name). */
  key: string;
  domain?: string;
  country: TargetCountry;
  regionGroup: RegionGroup;
  sizeTier: SizeTier;
  /** Higher = better fit inside its size tier. */
  score: number;
  /** Why it qualified (kept with the record so we know why a company was chosen). */
  reasons: string[];
}

export type Rejection = { qualified: false; reason: string };
export type Qualification = { qualified: true; company: QualifiedCompany } | Rejection;

/** Who a person is to us, in priority order. */
export const PERSONAS = ["recruiter", "hiring_manager", "leader", "referrer"] as const;
export type Persona = (typeof PERSONAS)[number];

/** A person found at a company by a contact provider (e.g. Apollo people search). */
export interface PersonCandidate {
  /** Which provider found this person, e.g. "apollo". */
  provider: string;
  /** The provider's ID for the person (used to enrich them later). */
  providerId?: string;
  name: string;
  title: string;
  companyName: string;
  companyDomain?: string;
  linkedinUrl?: string;
  email?: string;
  otherUrl?: string;
  /** Only when published for this person on a public page. */
  phone?: string;
  /** Public page the person (and their details) were found on. */
  sourceUrl?: string;
}

/**
 * verified    — a provider verified it (Apollo)
 * public      — published on a public page (the page is recorded)
 * unverified  — a provider returned it without verification
 * predicted   — generated from the company's published email pattern: Predicted / Unverified, check before sending
 * unavailable — none
 */
export type EmailStatus = "verified" | "public" | "unverified" | "predicted" | "unavailable";

export interface EnrichedPerson extends PersonCandidate {
  emailStatus: EmailStatus;
  /** Where the email came from (page URL, provider, or the pattern evidence). */
  emailSource?: string;
  /** Opaque account label that did the enrichment (never a credential). */
  enrichedBy?: string;
}

export interface RankedPerson extends EnrichedPerson {
  persona: Persona;
}

export type Employment = "internship" | "full_time" | "part_time" | "contract";

/** A job posting found by a job source (company career pages, supported job APIs). */
export interface JobCandidate {
  /** Which job source found it, e.g. "greenhouse", "lever", "careers-page". */
  source: string;
  sourceId?: string;
  companyName: string;
  /** Registry key of the company, when the job was found for a discovered company. */
  companyKey?: string;
  title: string;
  url: string;
  location?: string;
  remote?: boolean;
  /** As stated by the source, if it says so. Otherwise derived from the title. */
  employment?: Employment;
  postedAt?: string;
  description?: string;
}
