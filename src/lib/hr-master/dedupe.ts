import { duplicateGroupIdFor } from "./ids.ts";
import {
  cleanCompany,
  cleanName,
  companyKey,
  contactKindOf,
  emailDomain,
  emailKindOf,
  isPlaceholderName,
  nameKey,
  normalizeDomain,
  normalizeEmail,
} from "./normalize.ts";
import type { Conflict, DuplicateGroup, InvalidRecord, MergedContact, RawRecord, SourceRef } from "./types.ts";

/** Lower number wins when sources disagree: structured lists with named people first, the PDF last. */
const SOURCE_PRIORITY: Record<string, number> = {
  "data.json": 1,
  "HR_List_2026.xlsx": 2,
  "companies.md": 3,
  "unified_emails.csv": 4,
  "famous_it_companies_hr_e-mail_id-part-1.pdf": 5,
};
const priorityOf = (file: string) => SOURCE_PRIORITY[file] ?? 9;

const NOT_A_DESIGNATION = new Set(["general", "contact", "n/a", "na", "none", "unknown", "-"]);

export function cleanDesignation(raw: string): string {
  const d = (raw ?? "").normalize("NFKC").replace(/[�\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim();
  return NOT_A_DESIGNATION.has(d.toLowerCase()) || !/[a-z]/i.test(d) ? "" : d;
}

const designationKey = (d: string) => d.toLowerCase().replace(/[^a-z0-9]/g, "");

interface Candidate {
  value: string;
  source: SourceRef;
  priority: number;
}

function pickBest(cands: Candidate[], keyOf: (v: string) => string, field: Conflict["field"]): { chosen: string; conflict?: Conflict } {
  const present = cands.filter((c) => c.value);
  if (present.length === 0) return { chosen: "" };
  // Highest priority first; for equal priority prefer the fuller value (more words).
  const sorted = [...present].sort((a, b) => a.priority - b.priority || b.value.split(" ").length - a.value.split(" ").length);
  const chosen = sorted[0].value;
  const groups = new Map<string, Candidate[]>();
  for (const c of present) groups.set(keyOf(c.value) || c.value, [...(groups.get(keyOf(c.value) || c.value) ?? []), c]);
  const keys = [...groups.keys()];
  // Values where one key contains another ("akriti" vs "akriti sharma") are the same thing, not a conflict.
  const incompatible = keys.some((a) => keys.some((b) => a !== b && !(a.includes(b) || b.includes(a)) && !sameTokens(a, b)));
  if (!incompatible) return { chosen };
  return {
    chosen,
    conflict: {
      field,
      chosen,
      values: [...groups.values()].map((list) => ({ value: list[0].value, sources: list.map((c) => c.source) })),
    },
  };
}

function sameTokens(a: string, b: string): boolean {
  const ta = new Set(a.split(" "));
  const tb = b.split(" ");
  return tb.length > 0 && tb.every((t) => ta.has(t));
}

const ALT_EMAIL_RE = /\balt(?:ernate|ernative)?\s*(?:email|e-mail|mail)?\s*[:=-]\s*([^\s;,|]+@[^\s;,|]+)/gi;

export function alternateEmailsFrom(record: RawRecord): string[] {
  const text = [...Object.values(record.context), ...Object.values(record.original)].join(" | ");
  const out: string[] = [];
  for (const m of text.matchAll(ALT_EMAIL_RE)) {
    const n = normalizeEmail(m[1]);
    if (n.valid) out.push(n.email);
  }
  return out;
}

export interface DedupeStats {
  rawTotal: number;
  rawBySource: Record<string, number>;
  validEmailRecords: number;
  validBySource: Record<string, number>;
  invalidRecords: number;
  uniqueContacts: number;
  duplicateRecordsMerged: number;
  contactsInMultipleFiles: number;
  contactsWithConflicts: number;
  conflictCount: number;
  duplicateGroups: number;
  contactsInDuplicateGroups: number;
  sameNameDifferentCompanyNames: number;
}

export interface DedupeResult {
  contacts: MergedContact[];
  invalid: InvalidRecord[];
  groups: DuplicateGroup[];
  stats: DedupeStats;
}

const inc = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

/**
 * Merges raw records into one contact per normalised e-mail address. Two records are the SAME contact only when their
 * normalised e-mail addresses are identical (same name alone, or a shared company domain, never merges people). Different
 * contacts that look alike (same name, same company) are kept separate and listed in `groups` for human review.
 */
export function dedupe(records: readonly RawRecord[]): DedupeResult {
  const rawBySource: Record<string, number> = {};
  const validBySource: Record<string, number> = {};
  const invalid: InvalidRecord[] = [];
  const buckets = new Map<string, RawRecord[]>();

  for (const r of records) {
    inc(rawBySource, r.sourceFile);
    const n = normalizeEmail(r.email);
    if (n.valid && n.repaired) r.uncertainties.push("e-mail contained stray whitespace that was removed");
    if (!n.valid) {
      invalid.push({ record: r, reason: n.reason ?? "invalid" });
      continue;
    }
    inc(validBySource, r.sourceFile);
    const list = buckets.get(n.email);
    if (list) list.push(r);
    else buckets.set(n.email, [r]);
  }

  const contacts: MergedContact[] = [];
  let conflictCount = 0;
  let withConflicts = 0;
  let multiFile = 0;

  for (const [email, recs] of buckets) {
    const ref = (r: RawRecord): SourceRef => ({ file: r.sourceFile, location: r.sourceLocation });
    const cand = (pick: (r: RawRecord) => string): Candidate[] => recs.map((r) => ({ value: pick(r), source: ref(r), priority: priorityOf(r.sourceFile) }));

    const domain = emailDomain(email);
    const domainLabel = (domain.split(".")[0] ?? "").replace(/[^a-z0-9]/g, "");
    const domainForms = new Set([domainLabel, domain.split(".").slice(0, -1).join("").replace(/[^a-z0-9]/g, ""), ...domain.split(".").map((l) => l.replace(/[^a-z0-9]/g, ""))]);
    const usableName = (n: string) => !isPlaceholderName(n) && !domainForms.has(n.toLowerCase().replace(/[^a-z0-9]/g, "")) && !/[=@\d]/.test(n);
    const name = pickBest(cand((r) => (usableName(r.name) ? cleanName(r.name) : "")), nameKey, "PersonName");
    const droppedNames = recs.filter((r) => r.name.trim() && !usableName(r.name));
    const nameNote = droppedNames.length && !name.chosen ? ["name field held a placeholder/company-like value and was not used as a person name"] : [];
    const designation = pickBest(cand((r) => cleanDesignation(r.designation)), designationKey, "PersonDesignation");
    const company = pickBest(cand((r) => cleanCompany(r.company)), companyKey, "CompanyName");
    const conflicts = [name.conflict, designation.conflict, company.conflict].filter((c): c is Conflict => !!c);

    const hints = recs.map((r) => normalizeDomain(r.domainHint)).filter(Boolean);
    const alternates = [...new Set(recs.flatMap(alternateEmailsFrom))].filter((a) => a !== email);
    const sources: SourceRef[] = [];
    for (const r of recs) {
      const s = ref(r);
      if (!sources.some((x) => x.file === s.file && x.location === s.location)) sources.push(s);
    }
    if (new Set(sources.map((s) => s.file)).size > 1) multiFile++;
    if (conflicts.length) {
      withConflicts++;
      conflictCount += conflicts.length;
    }

    contacts.push({
      email,
      emailDomain: domain,
      emailKind: emailKindOf(domain),
      contactKind: contactKindOf(email, name.chosen),
      name: name.chosen,
      designation: designation.chosen,
      company: company.chosen,
      domainHint: hints[0] ?? "",
      alternateEmails: alternates,
      sources,
      originals: recs.map((r) => ({ source: ref(r), values: r.original })),
      uncertainties: [...new Set([...recs.flatMap((r) => r.uncertainties), ...nameNote])],
      conflicts,
      rawCount: recs.length,
    });
  }

  contacts.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  const groups = findReviewGroups(contacts);

  const nameToCompanies = new Map<string, Set<string>>();
  for (const c of contacts) {
    if (c.contactKind !== "person") continue;
    const k = nameKey(c.name);
    if (k.split(" ").length < 2) continue;
    const id = c.emailKind === "company" ? c.emailDomain : `${c.emailDomain}:${companyKey(c.company)}`;
    nameToCompanies.set(k, (nameToCompanies.get(k) ?? new Set()).add(id));
  }

  const validTotal = Object.values(validBySource).reduce((a, b) => a + b, 0);
  return {
    contacts,
    invalid,
    groups,
    stats: {
      rawTotal: records.length,
      rawBySource,
      validEmailRecords: validTotal,
      validBySource,
      invalidRecords: invalid.length,
      uniqueContacts: contacts.length,
      duplicateRecordsMerged: validTotal - contacts.length,
      contactsInMultipleFiles: multiFile,
      contactsWithConflicts: withConflicts,
      conflictCount,
      duplicateGroups: groups.length,
      contactsInDuplicateGroups: new Set(groups.flatMap((g) => g.emails)).size,
      sameNameDifferentCompanyNames: [...nameToCompanies.values()].filter((s) => s.size > 1).length,
    },
  };
}

/** Same person-name + same organisation but different e-mail addresses, or a declared alternate that is also its own contact. */
export function findReviewGroups(contacts: readonly MergedContact[]): DuplicateGroup[] {
  const byKey = new Map<string, MergedContact[]>();
  const known = new Map(contacts.map((c) => [c.email, c]));
  const groups: DuplicateGroup[] = [];

  for (const c of contacts) {
    if (c.contactKind !== "person") continue;
    const nk = nameKey(c.name);
    if (nk.split(" ").length < 2) continue;
    const org = c.emailKind === "company" ? c.emailDomain : `${c.emailDomain}|${companyKey(c.company)}`;
    if (c.emailKind !== "company" && !companyKey(c.company)) continue;
    const key = `${nk}@${org}`;
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    const emails = list.map((c) => c.email);
    groups.push({ id: duplicateGroupIdFor(emails), reason: "same name at the same organisation but different e-mail addresses (kept separate, needs review)", emails });
  }
  for (const c of contacts) {
    for (const alt of c.alternateEmails) {
      if (!known.has(alt)) continue;
      const emails = [c.email, alt];
      const id = duplicateGroupIdFor(emails);
      if (!groups.some((g) => g.id === id)) groups.push({ id, reason: "a declared alternate address is also listed as its own contact (kept separate, needs review)", emails });
    }
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : 1));
}
