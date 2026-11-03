/**
 * Integration CONTRACT for Part 2 (not wired to anything yet): how a master-database row maps to the existing Connections
 * fields, which rows are importable, and the key used to prevent duplicates. Pure; no Sheets/Gmail access.
 */
import { applyRoleProblem, type RoleCategory } from "../connections/apply-role.ts";
import { normalizeEmail } from "./normalize.ts";
import type { ApprovedRoleCategory, MasterContact } from "./types.ts";

/** Approved JobSync research category -> the Connections form's (RoleCategory, ApplyRole) pair. */
export const APPROVED_TO_APPLY_ROLE: Record<ApprovedRoleCategory, { roleCategory: RoleCategory; applyRole: string }> = {
  "Data Analyst": { roleCategory: "Data", applyRole: "Data Analyst" },
  "Data Engineer": { roleCategory: "Data", applyRole: "Data Engineer" },
  "AI Engineer": { roleCategory: "AI/ML", applyRole: "AI Engineer" },
  "AI/ML Engineer": { roleCategory: "AI/ML", applyRole: "AI/ML Engineer" },
  "AI Applied Engineer": { roleCategory: "AI/ML", applyRole: "Applied AI Engineer" },
  "Python Developer": { roleCategory: "AI/ML", applyRole: "Python Developer" },
  "Backend Engineer": { roleCategory: "SDE", applyRole: "Backend Engineer" },
  "Front End Developer / Engineer": { roleCategory: "Web D", applyRole: "Front End Developer" },
  "Full Stack Engineer": { roleCategory: "Web D", applyRole: "Full Stack Engineer" },
  "Software Developer Engineer": { roleCategory: "SDE", applyRole: "Software Developer" },
  "Software Engineer": { roleCategory: "SDE", applyRole: "Software Engineer" },
  "App Developer": { roleCategory: "Web D", applyRole: "App Developer" },
  // Not in the form's lists: imported as a custom "Other" role (allowed by applyRoleProblem).
  "MERN Stack Engineer": { roleCategory: "Other", applyRole: "MERN Stack Engineer" },
};

export interface ConnectionDraft {
  name: string;
  company: string;
  role: string;
  email: string;
  companyUrl: string;
  roleCategory: RoleCategory | "";
  applyRole: string;
  notes: string;
  /** Wording for message text: "Dear {salutation}" and "opportunities in {companyReference}". */
  salutation: string;
  companyReference: string;
}

/** Existing Connections columns each master field feeds (everything else stays in the master file). */
export const FIELD_MAP = {
  PersonName: "Name (fallback 'Hiring Team' when no person name is known); message text uses SalutationName / CompanyReference ('your company')",
  CompanyName: "Company",
  PersonDesignation: "Role (the person's designation; NOT the role to apply for)",
  PersonEmail: "Email",
  CompanyURL: "CompanyUrl",
  PrimaryRoleCategory: "RoleCategory + ApplyRole (via APPROVED_TO_APPLY_ROLE; 'Unverified' leaves both empty)",
  ContactID: "Notes (until a dedicated ContactID column exists)",
} as const;

export function toConnectionDraft(row: MasterContact): ConnectionDraft {
  const mapped = row.PrimaryRoleCategory === "Unverified" ? null : APPROVED_TO_APPLY_ROLE[row.PrimaryRoleCategory];
  return {
    name: row.SalutationName,
    company: row.CompanyName,
    role: row.PersonDesignation,
    email: row.PersonEmail,
    companyUrl: row.CompanyURL,
    roleCategory: mapped?.roleCategory ?? "",
    applyRole: mapped?.applyRole ?? "",
    notes: `HR master ${row.ContactID}`,
    salutation: row.SalutationName,
    companyReference: row.CompanyReference,
  };
}

export interface Readiness {
  importable: boolean;
  reasons: string[];
}

/**
 * Recommended minimum bar for Part 2 to import a row (a policy proposal, easy to tighten): a valid address, a company-owned
 * domain whose website was read, a company name, and a role that is at least Partially Verified.
 */
export function importReadiness(row: MasterContact): Readiness {
  const reasons: string[] = [];
  if (!normalizeEmail(row.PersonEmail).valid) reasons.push("invalid e-mail");
  if (row.EmailKind !== "company") reasons.push("not a company-owned address");
  if (row.CompanyVerificationStatus === "Unverified") reasons.push("company not verified");
  if (!row.CompanyName) reasons.push("no company name");
  if (row.PrimaryRoleCategory === "Unverified") reasons.push("no justified role category");
  if (row.ResolutionStatus === "pending-research") reasons.push("research not finished");
  return { importable: reasons.length === 0, reasons };
}

/** The duplicate-prevention key for Part 2: the normalised e-mail (also what ContactID is derived from). */
export const duplicateKey = (email: string): string => normalizeEmail(email).email;

/** Sanity check used by tests: every mapping satisfies the live Connections validation rules. */
export function mappingProblems(): string[] {
  return (Object.entries(APPROVED_TO_APPLY_ROLE) as [ApprovedRoleCategory, { roleCategory: RoleCategory; applyRole: string }][])
    .map(([k, v]) => ({ k, p: applyRoleProblem(v.roleCategory, v.applyRole) }))
    .filter((x) => x.p !== null)
    .map((x) => `${x.k}: ${x.p}`);
}
