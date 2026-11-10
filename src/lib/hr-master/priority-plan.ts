/**
 * Turns the rows of a new contact list (Mail-Data/new-data.xlsx: one company contact per row) into a PRIORITY IMPORT PLAN for the Outreach Database.
 * Pure: no Sheets, no files. The plan decides, for every row, whether it is new, promotes an existing Master Contacts row, or is skipped (and why),
 * orders the usable ones, and renders them as rows of the "Priority Contacts" tab (same columns as Master Contacts; see lib/outreach/priority.ts).
 *
 * Eligibility is the importer's own rule, nothing stricter and nothing looser:
 *   - a valid e-mail address that is not a legacy ISP address;
 *   - not a duplicate inside the file, not already imported (tracking), not already a Connection, not on the opt-out list;
 *   - a role JobSync can map to an approved category (the importer's "no mappable role category" rule): a company that lists no engineering role
 *     (sales / legal / operations only) is not imported.
 * Location, citizenship, visa and sponsorship wording are deliberately NOT used to exclude anybody.
 */
import { contactIdFor } from "./ids.ts";
import { emailDomain, emailKindOf, normalizeDomain, normalizeEmail } from "./normalize.ts";
import { MASTER_FIELDS, type MasterField } from "./types.ts";

export interface NewDataRow {
  /** 1-based row number in the source sheet (for traceability). */
  sourceRow: number;
  company: string;
  email: string;
  /** "Open roles / YC batch": the batch and the listed roles. */
  openRoles: string;
  /** "Founder / company profile": "Name · Role". */
  founderProfile: string;
  /** "Hiring checked": an Excel date serial or a date text. */
  hiringChecked: string;
  /** "Contact provenance": where the address came from. */
  provenance: string;
}

export type PlanStatus = "new" | "promote" | "already-imported" | "already-connection" | "opted-out" | "duplicate-in-file" | "invalid" | "legacy-isp" | "no-mappable-role";

/** The categories the importer can map to a role to apply for (see connections-mapping.ts); kept in step by a test. */
export type PlanRole = "Data Analyst" | "Data Engineer" | "AI Engineer" | "AI/ML Engineer" | "AI Applied Engineer" | "Python Developer" | "Backend Engineer" | "Front End Developer / Engineer" | "Full Stack Engineer" | "Software Developer Engineer" | "Software Engineer" | "App Developer" | "MERN Stack Engineer";

export interface PlanItem {
  status: PlanStatus;
  sourceRow: number;
  company: string;
  email: string;
  contactId: string;
  role: PlanRole | null;
  segment: "person-and-company" | "company-only";
  founderName: string;
  founderRole: string;
  reasons: string[];
  batch: string;
  provenance: string;
  hiringChecked: string;
  /** Position in the queue (set by `orderPlan`), counting from `firstPosition`. */
  position?: number;
}

export interface PlanContext {
  trackedEmails: ReadonlySet<string>;
  trackedIds: ReadonlySet<string>;
  connectionEmails: ReadonlySet<string>;
  /** Normalised e-mail -> ContactID of rows already in Master Contacts. */
  masterIdByEmail: ReadonlyMap<string, string>;
  exclusions: readonly { value: string; reason?: string }[];
}

/** The listed roles -> the importer's approved role category, or null when no engineering role is listed. */
export function mapRole(openRoles: string): PlanRole | null {
  const t = openRoles.toLowerCase();
  if (/\b(ai|ml|machine learning|llm|applied ai|agent)\b/.test(t)) return /applied/.test(t) ? "AI Applied Engineer" : "AI/ML Engineer";
  if (/data engineer|data platform/.test(t)) return "Data Engineer";
  if (/data (analyst|scientist)|analytics/.test(t)) return "Data Analyst";
  if (/full[- ]?stack/.test(t)) return "Full Stack Engineer";
  if (/front[- ]?end|frontend/.test(t)) return "Front End Developer / Engineer";
  if (/back[- ]?end|backend/.test(t)) return "Backend Engineer";
  if (/mobile|ios|android|app developer/.test(t)) return "App Developer";
  if (/software|engineer|developer|sde|swe|founding eng|infrastructure|platform|devops|sre|security eng/.test(t)) return "Software Engineer";
  return null;
}

const GENERIC_LOCAL = /^(hello|hi|contact|info|team|founders?|hiring|jobs|careers|talent|support|admin|office|work|join|apply|people|hr|recruiting|recruit|press|sales|mail|inquiries)$/;

function excludedBy(email: string, entries: PlanContext["exclusions"]): string | null {
  const e = normalizeEmail(email).email;
  const domain = e.slice(e.lastIndexOf("@") + 1);
  for (const x of entries) {
    const v = x.value.trim().toLowerCase();
    if (!v) continue;
    if (v.includes("@") && !v.startsWith("@")) {
      if (normalizeEmail(v).email === e) return x.reason || v;
    } else {
      const d = normalizeDomain(v.replace(/^@/, ""));
      if (d && (domain === d || domain.endsWith("." + d))) return x.reason || d;
    }
  }
  return null;
}

/** An Excel date serial ("46302.0") or a date text -> YYYY-MM-DD; "" when unknown. */
export function dateOf(raw: string): string {
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const n = Number(t);
  if (Number.isFinite(n) && n > 20000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000).toISOString().slice(0, 10);
  return "";
}

export function planPriorityContacts(rows: readonly NewDataRow[], ctx: PlanContext): PlanItem[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const norm = normalizeEmail(r.email);
    const [name = "", ...roleParts] = r.founderProfile.split("·").map((s) => s.trim());
    const local = norm.email.split("@")[0] ?? "";
    const tokens = name.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const personal = Boolean(name) && !GENERIC_LOCAL.test(local) && tokens.some((t) => local.includes(t));
    const base: PlanItem = {
      status: "new", sourceRow: r.sourceRow, company: r.company, email: norm.valid ? norm.email : r.email.trim(), contactId: norm.valid ? contactIdFor(norm.email) : "",
      role: mapRole(r.openRoles), segment: personal ? "person-and-company" : "company-only", founderName: personal ? name : "", founderRole: personal ? roleParts.join(" · ") : "", reasons: [],
      batch: /YC\s+[A-Z]\d{2}/.exec(r.openRoles)?.[0] ?? "YC", provenance: r.provenance.split("\n")[0] ?? "", hiringChecked: dateOf(r.hiringChecked),
    };
    const skip = (status: PlanStatus, reason: string): PlanItem => ({ ...base, status, reasons: [reason] });
    if (!norm.valid) return skip("invalid", `invalid e-mail (${norm.reason})`);
    if (emailKindOf(emailDomain(norm.email)) === "legacy-isp") return skip("legacy-isp", "legacy ISP address");
    const dup = seen.get(norm.email);
    if (dup !== undefined) return skip("duplicate-in-file", `same e-mail as row ${dup}`);
    seen.set(norm.email, r.sourceRow);
    if (ctx.trackedEmails.has(norm.email) || ctx.trackedIds.has(base.contactId)) return skip("already-imported", "already imported (tracking row exists)");
    if (ctx.connectionEmails.has(norm.email)) return skip("already-connection", "already a Connection");
    const out = excludedBy(norm.email, ctx.exclusions);
    if (out) return skip("opted-out", `on the opt-out list (${out})`);
    // A contact already in Master Contacts is promoted on ITS OWN Master data (it is judged by the importer exactly as before, with its own role
    // category); only a genuinely new contact needs a mappable role from this file.
    const inMaster = ctx.masterIdByEmail.get(norm.email);
    if (inMaster) return { ...base, status: "promote", contactId: inMaster, reasons: ["already in Master Contacts, not yet imported: promoted, not re-added"] };
    if (!base.role) return skip("no-mappable-role", "no engineering role listed (importer rule: no mappable role category)");
    return base;
  });
}

/** The usable items (new + promoted) in queue order: best-identified first (a named person before a company mailbox), then the source order. */
export function orderPlan(items: readonly PlanItem[], firstPosition: number): PlanItem[] {
  const usable = items.filter((i) => i.status === "new" || i.status === "promote");
  usable.sort((a, b) => Number(a.segment !== "person-and-company") - Number(b.segment !== "person-and-company") || a.sourceRow - b.sourceRow);
  return usable.map((i, n) => ({ ...i, position: firstPosition + n }));
}

/** Rows for the "Priority Contacts" tab: the Master Contacts header, then one row per planned contact (a promoted contact is an ID-only row). */
export function priorityTabRows(ordered: readonly PlanItem[], sourceFile = "new-data.xlsx"): string[][] {
  const rows = ordered.map((i) => {
    if (i.status === "promote") return MASTER_FIELDS.map((f) => (f === "ContactID" ? i.contactId : ""));
    const domain = emailDomain(i.email);
    const v: Partial<Record<MasterField, string>> = {
      ContactID: i.contactId, PersonName: i.founderName, PersonDesignation: i.founderRole, PersonEmail: i.email, EmailDomain: domain, CompanyName: i.company,
      CompanyURL: `https://${domain}`, CompanyDomain: domain, PrimaryRoleCategory: i.role ?? "", HiringEvidence: `Listed open roles (${i.batch || "YC"})${i.hiringChecked ? `, checked ${i.hiringChecked}` : ""}`,
      PersonVerificationStatus: "Unverified", CompanyVerificationStatus: "Listed in the YC company directory", RoleVerificationStatus: "Listed open role",
      ResearchSources: i.provenance, SourceFiles: sourceFile, SourceLocations: `${sourceFile}: row ${i.sourceRow}`, LastResearchedAt: i.hiringChecked,
      ContactKind: i.founderName ? "person" : "role-mailbox", EmailKind: "company", Conflicts: "[]", ResolutionStatus: "resolved", RoleBasis: `listed open role (${sourceFile})`,
      SalutationName: i.founderName || "Hiring Team", CompanyReference: i.company, SchemaVersion: "2",
    };
    return MASTER_FIELDS.map((f) => v[f] ?? "");
  });
  return [[...MASTER_FIELDS], ...rows];
}
