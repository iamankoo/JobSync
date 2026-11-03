import { z } from "zod";
import { contactIdFor } from "./ids.ts";
import { APPROVED_ROLE_CATEGORIES, FALLBACK_COMPANY_REFERENCE, FALLBACK_SALUTATION, MASTER_FIELDS, SCHEMA_VERSION, type MasterContact } from "./types.ts";

const verification = z.enum(["Verified", "Partially Verified", "Unverified"]);
const role = z.enum(APPROVED_ROLE_CATEGORIES);
const sourceRef = z.strictObject({ file: z.string().min(1), location: z.string().min(1) });
const httpUrl = z.string().refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v), "must be empty or an http(s) URL");
const domain = z.string().refine((v) => v === "" || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v), "must be empty or a lower-case domain");

/** Runtime contract for one master-database row. Strict: unknown fields are rejected so the schema cannot drift silently. */
export const masterContactSchema = z.strictObject({
  ContactID: z.string().regex(/^HRC-[0-9A-F]{12}$/),
  PersonName: z.string(),
  PersonDesignation: z.string(),
  PersonEmail: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).refine((v) => v === v.toLowerCase(), "must be lower-case"),
  EmailDomain: domain.refine((v) => v !== "", "required"),
  CompanyName: z.string(),
  CompanyURL: httpUrl,
  CompanyDomain: domain,
  PrimaryRoleCategory: z.union([role, z.literal("Unverified")]),
  AdditionalRoleCategories: z.array(role),
  CompanyDescription: z.string(),
  HiringEvidence: z.string(),
  PersonVerificationStatus: verification,
  CompanyVerificationStatus: verification,
  RoleVerificationStatus: verification,
  ResearchSources: z.array(httpUrl),
  SourceFiles: z.array(z.string().min(1)).min(1),
  SourceLocations: z.array(z.string().min(1)).min(1),
  DuplicateGroup: z.string(),
  ResearchNotes: z.string(),
  LastResearchedAt: z.string().refine((v) => v === "" || !Number.isNaN(Date.parse(v)), "must be empty or ISO-8601"),
  ContactKind: z.enum(["person", "role-mailbox", "unknown"]),
  EmailKind: z.enum(["company", "public-provider", "legacy-isp"]),
  AlternateEmails: z.array(z.string()),
  CareersURL: httpUrl,
  PersonEvidence: z.string(),
  Conflicts: z.array(
    z.strictObject({
      field: z.enum(["PersonName", "PersonDesignation", "CompanyName"]),
      chosen: z.string(),
      values: z.array(z.strictObject({ value: z.string(), sources: z.array(sourceRef) })),
    }),
  ),
  ResolutionStatus: z.enum(["resolved", "unresolved", "pending-research"]),
  SalutationName: z.string().min(1),
  CompanyReference: z.string().min(1),
  RoleBasis: z.enum(["", "careers-listing", "company-description", "company-inferred", "default-fallback"]),
  SchemaVersion: z.literal(SCHEMA_VERSION),
});

export interface ValidationIssue {
  row: number;
  contactId: string;
  problem: string;
}

/** Row-level schema checks plus the cross-row invariants a future importer relies on. */
export function validateMaster(rows: readonly unknown[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const emails = new Set<string>();
  rows.forEach((raw, i) => {
    const parsed = masterContactSchema.safeParse(raw);
    const id = String((raw as { ContactID?: unknown })?.ContactID ?? "");
    if (!parsed.success) {
      for (const e of parsed.error.issues) issues.push({ row: i, contactId: id, problem: `${e.path.join(".") || "(row)"}: ${e.message}` });
      return;
    }
    const r: MasterContact = parsed.data as MasterContact;
    if (ids.has(r.ContactID)) issues.push({ row: i, contactId: id, problem: "duplicate ContactID" });
    if (emails.has(r.PersonEmail)) issues.push({ row: i, contactId: id, problem: "duplicate PersonEmail" });
    ids.add(r.ContactID);
    emails.add(r.PersonEmail);
    if (r.ContactID !== contactIdFor(r.PersonEmail)) issues.push({ row: i, contactId: id, problem: "ContactID does not match its e-mail" });
    if (r.PrimaryRoleCategory === "Unverified" && r.RoleVerificationStatus !== "Unverified") issues.push({ row: i, contactId: id, problem: "Unverified role category with a verified status" });
    if (r.PrimaryRoleCategory !== "Unverified" && r.RoleVerificationStatus === "Unverified" && r.RoleBasis !== "default-fallback") issues.push({ row: i, contactId: id, problem: "role category set but status Unverified" });
    if (r.CompanyVerificationStatus === "Verified" && (!r.CompanyURL || !r.CompanyDomain)) issues.push({ row: i, contactId: id, problem: "Verified company without URL/domain" });
    if (r.CompanyVerificationStatus !== "Unverified" && r.ResearchSources.length === 0) issues.push({ row: i, contactId: id, problem: "company status above Unverified without evidence URLs" });
    if (r.RoleVerificationStatus === "Verified" && !r.CareersURL) issues.push({ row: i, contactId: id, problem: "Verified role without careers URL" });
    if (r.RoleBasis === "default-fallback" && (r.RoleVerificationStatus !== "Unverified" || r.PrimaryRoleCategory !== "Software Engineer" ))  issues.push({ row: i, contactId: id, problem: "default-fallback must be an Unverified Software Engineer" });
    if ((r.PrimaryRoleCategory === "Unverified") !== (r.RoleBasis === "")) issues.push({ row: i, contactId: id, problem: "RoleBasis must be set exactly when a role category is set" });
    if (r.RoleBasis === "company-inferred" && r.RoleVerificationStatus === "Verified") issues.push({ row: i, contactId: id, problem: "company-inferred role cannot be Verified" });
    if (r.SalutationName !== (r.PersonName || FALLBACK_SALUTATION)) issues.push({ row: i, contactId: id, problem: "SalutationName must be the person name or the fallback" });
    if (r.CompanyReference !== (r.CompanyName || FALLBACK_COMPANY_REFERENCE)) issues.push({ row: i, contactId: id, problem: "CompanyReference must be the company name or the fallback" });
    if (r.AdditionalRoleCategories.includes(r.PrimaryRoleCategory as never)) issues.push({ row: i, contactId: id, problem: "primary role repeated in additional roles" });
  });
  return issues;
}

/** Column order of the CSV export (required fields first, in the order of the brief). */
export const CSV_COLUMNS = MASTER_FIELDS;
