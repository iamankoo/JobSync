/**
 * Part 1 (HR contact research) types. Pure data shapes: nothing here touches Google Sheets, Gmail or the network.
 */

export const SOURCE_FILES = [
  "famous_it_companies_hr_e-mail_id-part-1.pdf",
  "HR_List_2026.xlsx",
  "companies.md",
  "unified_emails.csv",
  "data.json",
] as const;

export type SourceFormat = "pdf" | "xlsx" | "md" | "csv" | "json";

/** One record exactly as read from a source, before any normalisation or merging. */
export interface RawRecord {
  sourceFile: string;
  /** "row 12", "page 3 line 41", "record 7" ... as precise as the format allows. */
  sourceLocation: string;
  /** Verbatim values as found (strings only; nothing trimmed beyond what the parser needs). */
  original: Record<string, string>;
  email: string;
  name: string;
  designation: string;
  company: string;
  /** Company domain/URL hint given by the source itself (companies.md), if any. */
  domainHint: string;
  /** Location, department, description ... free context from the source. */
  context: Record<string, string>;
  /** Things the parser was unsure about (e.g. "company inferred from preceding line"). */
  uncertainties: string[];
}

export interface ExtractionResult {
  sourceFile: string;
  format: SourceFormat;
  records: RawRecord[];
}

export type Verification = "Verified" | "Partially Verified" | "Unverified";

export const APPROVED_ROLE_CATEGORIES = [
  "Data Analyst",
  "Data Engineer",
  "AI Engineer",
  "AI/ML Engineer",
  "AI Applied Engineer",
  "Python Developer",
  "Backend Engineer",
  "Front End Developer / Engineer",
  "Full Stack Engineer",
  "Software Developer Engineer",
  "Software Engineer",
  "App Developer",
  "MERN Stack Engineer",
] as const;
export type ApprovedRoleCategory = (typeof APPROVED_ROLE_CATEGORIES)[number];
export type RoleCategoryOrUnverified = ApprovedRoleCategory | "Unverified";

export type ContactKind = "person" | "role-mailbox" | "unknown";
export type EmailKind = "company" | "public-provider" | "legacy-isp";

export interface SourceRef {
  file: string;
  location: string;
}

export interface Conflict {
  field: "PersonName" | "PersonDesignation" | "CompanyName";
  chosen: string;
  /** Every distinct value seen with the sources that supplied it. */
  values: { value: string; sources: SourceRef[] }[];
}

/** Output of deduplication: one entry per normalised email address. */
export interface MergedContact {
  email: string;
  emailDomain: string;
  emailKind: EmailKind;
  contactKind: ContactKind;
  name: string;
  designation: string;
  company: string;
  domainHint: string;
  alternateEmails: string[];
  sources: SourceRef[];
  originals: { source: SourceRef; values: Record<string, string> }[];
  uncertainties: string[];
  conflicts: Conflict[];
  /** Number of raw records folded into this contact. */
  rawCount: number;
}

export interface DuplicateGroup {
  id: string;
  reason: string;
  /** Normalised emails of the contacts that are NOT merged but need a human look. */
  emails: string[];
}

export interface InvalidRecord {
  record: RawRecord;
  reason: string;
}

/** Research gathered about one company domain (company-level facts are researched once and reused). */
export interface CompanyResearch {
  domain: string;
  status: "researched" | "unreachable" | "parked" | "blocked-by-robots" | "error";
  fetchedAt: string;
  finalUrl?: string;
  /** Registrable domain of the final URL after redirects. */
  finalDomain?: string;
  siteName?: string;
  title?: string;
  description?: string;
  careersUrl?: string;
  /** Job-title phrases found on the fetched careers page. */
  careersTitles?: string[];
  /** Plain-text excerpt used for keyword classification (never stored in full). */
  textSample?: string;
  error?: string;
  sources: string[];
}

export interface RoleAssessment {
  primary: RoleCategoryOrUnverified;
  additional: ApprovedRoleCategory[];
  status: Verification;
  evidence: string;
  /** Where the category came from; "" when no category. */
  basis?: RoleBasis;
}

/** careers-listing = job title on the careers page; company-description = business description matched a category;
 *  company-inferred = classified only from what the company mainly does (software vs AI), NOT an individual designation.
 *  default-fallback = no company identity/evidence existed, so "Software Engineer" was applied as the agreed default; unverified. */
export type RoleBasis = "" | "careers-listing" | "company-description" | "company-inferred" | "default-fallback";

export interface CompanyAssessment {
  name: string;
  url: string;
  domain: string;
  status: Verification;
  description: string;
  careersUrl: string;
  notes: string[];
}

export const MASTER_FIELDS = [
  "ContactID",
  "PersonName",
  "PersonDesignation",
  "PersonEmail",
  "EmailDomain",
  "CompanyName",
  "CompanyURL",
  "CompanyDomain",
  "PrimaryRoleCategory",
  "AdditionalRoleCategories",
  "CompanyDescription",
  "HiringEvidence",
  "PersonVerificationStatus",
  "CompanyVerificationStatus",
  "RoleVerificationStatus",
  "ResearchSources",
  "SourceFiles",
  "SourceLocations",
  "DuplicateGroup",
  "ResearchNotes",
  "LastResearchedAt",
  // Additional fields (the required ones above are never removed).
  "ContactKind",
  "EmailKind",
  "AlternateEmails",
  "CareersURL",
  "PersonEvidence",
  "Conflicts",
  "ResolutionStatus",
  "RoleBasis",
  "SalutationName",
  "CompanyReference",
  "SchemaVersion",
] as const;
export type MasterField = (typeof MASTER_FIELDS)[number];

export const SCHEMA_VERSION = 2;

/** Used in message text when the data has no person name / no company name. */
export const FALLBACK_SALUTATION = "Hiring Team";
export const FALLBACK_COMPANY_REFERENCE = "your company";

export interface MasterContact {
  ContactID: string;
  PersonName: string;
  PersonDesignation: string;
  PersonEmail: string;
  EmailDomain: string;
  CompanyName: string;
  CompanyURL: string;
  CompanyDomain: string;
  PrimaryRoleCategory: RoleCategoryOrUnverified;
  AdditionalRoleCategories: ApprovedRoleCategory[];
  CompanyDescription: string;
  HiringEvidence: string;
  PersonVerificationStatus: Verification;
  CompanyVerificationStatus: Verification;
  RoleVerificationStatus: Verification;
  ResearchSources: string[];
  SourceFiles: string[];
  SourceLocations: string[];
  DuplicateGroup: string;
  ResearchNotes: string;
  /** ISO-8601 UTC; empty string when the company has not been researched yet. */
  LastResearchedAt: string;
  ContactKind: ContactKind;
  EmailKind: EmailKind;
  AlternateEmails: string[];
  CareersURL: string;
  PersonEvidence: string;
  Conflicts: Conflict[];
  /** "resolved" | "unresolved" | "pending-research" */
  ResolutionStatus: "resolved" | "unresolved" | "pending-research";
  RoleBasis: RoleBasis;
  /** Name to greet: the person's name, or "Hiring Team" when no individual name is known ("Dear Hiring Team"). */
  SalutationName: string;
  /** Company wording for message text: the company name, or "your company" when none is known ("opportunities in your company"). */
  CompanyReference: string;
  SchemaVersion: number;
}
