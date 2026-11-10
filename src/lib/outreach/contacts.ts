/**
 * Reading the Outreach Database, classifying contacts and deciding who may be imported. Pure functions over rows already
 * read, so every rule is unit-testable.
 */
import { contactIdFor } from "@/lib/hr-master/ids";
import { normalizeEmail } from "@/lib/hr-master/normalize";
import { APPROVED_TO_APPLY_ROLE } from "@/lib/hr-master/connections-mapping";
import type { ApprovedRoleCategory } from "@/lib/hr-master/types";
import type { OutreachContact, Segment } from "./types";

export const REQUIRED_COLUMNS = [
  "ContactID", "PersonName", "PersonDesignation", "PersonEmail", "CompanyName", "CompanyURL", "CompanyDescription", "PrimaryRoleCategory",
  "RoleBasis", "RoleVerificationStatus", "CompanyVerificationStatus", "ContactKind", "EmailKind", "DuplicateGroup", "SalutationName", "CompanyReference",
] as const;

export interface ParsedSource {
  contacts: OutreachContact[];
  /** Rows that were not usable, with the reason (never imported, never deleted). */
  rejected: { sheetRow: number; contactId: string; reason: string }[];
}

/** Parses the Master Contacts grid (header + rows). Throws when a required column is missing; the sheet is never written. */
/**
 * The Master Contacts grid is cached for 20 minutes and is read by the send step, the importer and the counters in every cycle: parse each cached grid
 * object ONCE (15,891 rows today) and share the result. Results are read-only. A new grid object (a fresh read) is parsed afresh.
 */
const parsedMemo = new WeakMap<object, ParsedSource>();
export function parseMasterRows(grid: readonly (readonly string[])[]): ParsedSource {
  const hit = parsedMemo.get(grid);
  if (hit) return hit;
  const parsed = parseMasterRowsUncached(grid);
  parsedMemo.set(grid, parsed);
  return parsed;
}

function parseMasterRowsUncached(grid: readonly (readonly string[])[]): ParsedSource {
  const header = (grid[0] ?? []).map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const missing = REQUIRED_COLUMNS.filter((c) => !(c in idx));
  if (missing.length) throw new Error(`Master Contacts is missing required column(s): ${missing.join(", ")}`);
  const contacts: OutreachContact[] = [];
  const rejected: ParsedSource["rejected"] = [];
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const cell = (c: (typeof REQUIRED_COLUMNS)[number]) => (row[idx[c]] ?? "").toString().trim();
    if (row.every((c) => !String(c ?? "").trim())) continue;
    const sheetRow = r + 1;
    const contactId = cell("ContactID");
    const norm = normalizeEmail(cell("PersonEmail"));
    const bad = (reason: string) => rejected.push({ sheetRow, contactId, reason });
    if (!norm.valid) { bad(`invalid e-mail (${norm.reason})`); continue; }
    if (contactId !== contactIdFor(norm.email)) { bad("ContactID does not match the e-mail address"); continue; }
    if (norm.email !== cell("PersonEmail")) { bad("e-mail is not stored in normalised form"); continue; }
    if (seenIds.has(contactId) || seenEmails.has(norm.email)) { bad("duplicate ContactID or e-mail inside the Outreach Database"); continue; }
    seenIds.add(contactId);
    seenEmails.add(norm.email);
    contacts.push({
      contactId,
      personName: cell("PersonName"),
      personDesignation: cell("PersonDesignation"),
      personEmail: norm.email,
      companyName: cell("CompanyName"),
      companyUrl: cell("CompanyURL"),
      companyDescription: cell("CompanyDescription"),
      primaryRoleCategory: cell("PrimaryRoleCategory"),
      roleBasis: cell("RoleBasis"),
      roleVerificationStatus: cell("RoleVerificationStatus"),
      companyVerificationStatus: cell("CompanyVerificationStatus"),
      contactKind: cell("ContactKind"),
      emailKind: cell("EmailKind"),
      duplicateGroup: cell("DuplicateGroup"),
      salutationName: cell("SalutationName"),
      companyReference: cell("CompanyReference"),
      sheetRow,
    });
  }
  return { contacts, rejected };
}

import { FALLBACK_COMPANY, FALLBACK_SALUTATION } from "@/config/outreach-wording";
export { FALLBACK_COMPANY, FALLBACK_SALUTATION };

/** The four contact-quality segments (person known? company known?) from the ORIGINAL PersonName / CompanyName. */
export function segmentOf(c: Pick<OutreachContact, "personName" | "companyName">): Segment {
  const p = Boolean(c.personName.trim());
  const co = Boolean(c.companyName.trim());
  return p && co ? "person-and-company" : co ? "company-only" : p ? "person-only" : "neither";
}

/** Wording for message text. NEVER written back into PersonName / CompanyName. */
export const salutationFor = (c: Pick<OutreachContact, "personName">) => c.personName.trim() || FALLBACK_SALUTATION;
export const companyReferenceFor = (c: Pick<OutreachContact, "companyName">) => c.companyName.trim() || FALLBACK_COMPANY;

/** The stored fallbacks must agree with the rule; a mismatch means the sheet was edited by hand. */
export function fallbacksConsistent(c: OutreachContact): boolean {
  return c.salutationName === salutationFor(c) && c.companyReference === companyReferenceFor(c);
}

const NOT_A_HIRING_CONTACT = /\b(angel )?investors?\b/i;

export interface Eligibility {
  eligible: boolean;
  reasons: string[];
}

/**
 * Who may be imported. A policy, deliberately simple and visible:
 *  - the row must have survived parsing (valid e-mail, ContactID matches);
 *  - not a legacy ISP address (2000s-era mailboxes: stale, shared by unrelated customers);
 *  - not an investor entry (the source lists angel investors, who are not hiring contacts);
 *  - a role category must map to the Connections role lists;
 *  - only the FIRST member of a possible-duplicate review group (same name at the same organisation) is imported, so the
 *    same person is not approached at several addresses.
 * Role verification is NOT a requirement: a default-fallback Software Engineer is a targeting choice for outreach, never a
 * verified opening, and is recorded as such (RoleBasis stays on the tracking row and the Connection's notes).
 */
export function importEligibility(c: OutreachContact, firstInGroup: ReadonlySet<string>): Eligibility {
  const reasons: string[] = [];
  if (c.emailKind === "legacy-isp") reasons.push("legacy ISP address");
  if (NOT_A_HIRING_CONTACT.test(c.personDesignation) || NOT_A_HIRING_CONTACT.test(c.companyName)) reasons.push("investor entry, not a hiring contact");
  if (!(c.primaryRoleCategory in APPROVED_TO_APPLY_ROLE)) reasons.push("no mappable role category");
  if (c.duplicateGroup && !firstInGroup.has(c.contactId)) reasons.push("possible duplicate of another contact (review group)");
  return { eligible: reasons.length === 0, reasons };
}

const eligibleMemo = new WeakMap<object, Set<string>>();
/** ContactIDs of a parsed Master that pass the import eligibility rules (computed once per parsed grid). */
export function eligibleIdSet(parsed: ParsedSource): Set<string> {
  const hit = eligibleMemo.get(parsed);
  if (hit) return hit;
  const first = firstInDuplicateGroups(parsed.contacts);
  const ids = new Set(parsed.contacts.filter((c) => importEligibility(c, first).eligible).map((c) => c.contactId));
  eligibleMemo.set(parsed, ids);
  return ids;
}

/** ContactIDs that are first in their duplicate group(s) by ContactID order. */
const firstMemo = new WeakMap<object, Set<string>>();
export function firstInDuplicateGroups(contacts: readonly OutreachContact[]): Set<string> {
  const memo = firstMemo.get(contacts);
  if (memo) return memo;
  const first = firstInDuplicateGroupsUncached(contacts);
  firstMemo.set(contacts, first);
  return first;
}

function firstInDuplicateGroupsUncached(contacts: readonly OutreachContact[]): Set<string> {
  const byGroup = new Map<string, string[]>();
  for (const c of contacts) {
    if (!c.duplicateGroup) continue;
    for (const g of c.duplicateGroup.split(";")) byGroup.set(g, [...(byGroup.get(g) ?? []), c.contactId]);
  }
  const first = new Set<string>();
  for (const c of contacts) {
    if (!c.duplicateGroup) continue;
    if (c.duplicateGroup.split(";").every((g) => [...(byGroup.get(g) ?? [])].sort()[0] === c.contactId)) first.add(c.contactId);
  }
  return first;
}

const SEGMENT_RANK: Record<Segment, number> = { "person-and-company": 0, "company-only": 1, "person-only": 2, neither: 3 };
const EMAIL_RANK: Record<string, number> = { company: 0, "public-provider": 1, "legacy-isp": 2 };

/**
 * Import order: best-identified contacts first (person + company, then company only, ...), company-owned addresses before
 * public ones, then ContactID. Deterministic, so a retried or resumed run picks exactly the same next contact.
 */
export function importOrder(a: OutreachContact, b: OutreachContact): number {
  return (
    SEGMENT_RANK[segmentOf(a)] - SEGMENT_RANK[segmentOf(b)] ||
    (EMAIL_RANK[a.emailKind] ?? 3) - (EMAIL_RANK[b.emailKind] ?? 3) ||
    (a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0)
  );
}

export const roleMapping = (primaryRoleCategory: string) => APPROVED_TO_APPLY_ROLE[primaryRoleCategory as ApprovedRoleCategory];
