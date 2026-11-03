/**
 * Builds the Master Contact Database rows from deduplicated contacts plus per-domain research. Pure and deterministic:
 * the same inputs always give the same rows and the same ContactIDs (only LastResearchedAt carries the research time).
 */
import { classifyCompanyFocus, classifyFromBody, classifyFromName } from "./company-focus.ts";
import { contactIdFor } from "./ids.ts";
import { companyDomainMismatch, companyKey, normalizeDomain, registrableDomain } from "./normalize.ts";
import { assessCompany, assessPerson, assessRole } from "./research.ts";
import {
  FALLBACK_COMPANY_REFERENCE,
  FALLBACK_SALUTATION,
  SCHEMA_VERSION,
  type CompanyAssessment,
  type CompanyResearch,
  type DuplicateGroup,
  type MasterContact,
  type MergedContact,
  type RoleAssessment,
} from "./types.ts";

export interface CompanyRecord {
  domain: string;
  company: CompanyAssessment;
  role: RoleAssessment;
  researched: boolean;
  researchedAt: string;
  sources: string[];
  contactCount: number;
}

function claimedNamesByDomain(contacts: readonly MergedContact[]): Map<string, string[]> {
  const counts = new Map<string, Map<string, number>>();
  for (const c of contacts) {
    if (c.emailKind !== "company" || !c.company) continue;
    const m = counts.get(c.emailDomain) ?? new Map<string, number>();
    m.set(c.company, (m.get(c.company) ?? 0) + 1);
    counts.set(c.emailDomain, m);
  }
  const out = new Map<string, string[]>();
  for (const [d, m] of counts) out.set(d, [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n]) => n));
  return out;
}

/** One record per company-owned e-mail domain: company facts are assessed once and reused for every contact there. */
export interface AboutPage {
  domain: string;
  url: string;
  text: string;
  fetchedAt: string;
}

/** Last-resort, clearly labelled company-based classification (software vs AI) for otherwise Unverified roles. */
export function inferRoleFromCompany(r: CompanyResearch | undefined, about: AboutPage | undefined): RoleAssessment | null {
  if (!r || r.status !== "researched") return null;
  // A domain that redirects to another organisation's site says nothing reliable about this company.
  if (r.finalDomain && registrableDomain(r.finalDomain) !== registrableDomain(r.domain)) return null;
  const focus = classifyCompanyFocus({ title: r.title, siteName: r.siteName, description: r.description, about: about?.text });
  if (!focus) {
    const body = classifyFromBody({ title: r.title, siteName: r.siteName, description: r.description, textSample: r.textSample });
    if (!body) return null;
    return {
      primary: body.category,
      additional: [],
      status: "Partially Verified",
      basis: "company-inferred",
      evidence: `COMPANY-BASED INFERENCE (not a verified designation, and no opening is confirmed): the company's own homepage (${r.finalUrl ?? ""}) repeatedly describes ${body.category === "AI Engineer" ? "AI/ML" : "software"} work - signals: ${body.signals.join(", ")}. "${[r.title, r.description].filter(Boolean).join(" - ").replace(/\s+/g, " ").slice(0, 160)}"`,
    };
  }
  const src = focus.from === "about" && about ? about.url : (r.finalUrl ?? "");
  const quote = (focus.from === "about" ? about?.text : [r.title, r.description].filter(Boolean).join(" - "))?.replace(/\s+/g, " ").slice(0, 160) ?? "";
  return {
    primary: focus.category,
    additional: [],
    status: "Partially Verified",
    basis: "company-inferred",
    evidence: `COMPANY-BASED INFERENCE (not a verified designation, and no opening is confirmed): the company's own ${focus.from === "about" ? "About page" : "homepage"} (${src}) describes it as ${focus.category === "AI Engineer" ? "an AI/ML-focused" : "a software-focused"} business - signals: ${focus.signals.join(", ")}. "${quote}"`,
  };
}

export function buildCompanyRecords(
  contacts: readonly MergedContact[],
  research: ReadonlyMap<string, CompanyResearch>,
  about: ReadonlyMap<string, AboutPage> = new Map(),
): Map<string, CompanyRecord> {
  const claimed = claimedNamesByDomain(contacts);
  const count = new Map<string, number>();
  for (const c of contacts) if (c.emailKind === "company") count.set(c.emailDomain, (count.get(c.emailDomain) ?? 0) + 1);
  const out = new Map<string, CompanyRecord>();
  for (const [domain, n] of [...count.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const r = research.get(domain);
    let role: RoleAssessment = r ? assessRole(r) : { primary: "Unverified", additional: [], status: "Unverified", evidence: "Not researched yet." };
    let sources = r?.sources ?? [];
    if (role.primary === "Unverified") {
      const inferred = inferRoleFromCompany(r, about.get(domain));
      if (inferred) {
        role = inferred;
        const a = about.get(domain);
        if (a && inferred.evidence.includes(a.url)) sources = [...sources, a.url];
      }
    }
    out.set(domain, {
      domain,
      company: assessCompany(domain, claimed.get(domain) ?? [], r),
      role,
      researched: !!r,
      researchedAt: r?.fetchedAt ?? "",
      sources,
      contactCount: n,
    });
  }
  return out;
}

export function buildMaster(
  contacts: readonly MergedContact[],
  groups: readonly DuplicateGroup[],
  companies: ReadonlyMap<string, CompanyRecord>,
): MasterContact[] {
  const groupOf = new Map<string, string>();
  for (const g of groups) for (const e of g.emails) groupOf.set(e, groupOf.get(e) ? `${groupOf.get(e)};${g.id}` : g.id);

  const rows = contacts.map((c): MasterContact => {
    const rec = c.emailKind === "company" ? companies.get(c.emailDomain) : undefined;
    const notes: string[] = [];

    const unresolvedCompany: CompanyAssessment = { name: c.company, url: "", domain: "", status: "Unverified", description: "", careersUrl: "", notes: [] };
    const company = rec?.company ?? unresolvedCompany;
    let role: RoleAssessment = rec?.role ?? { primary: "Unverified", additional: [], status: "Unverified", evidence: "" };
    if (role.primary === "Unverified") {
      const named = classifyFromName(company.name || c.company);
      if (named) {
        role = {
          primary: named.category,
          additional: [],
          status: "Partially Verified",
          basis: "company-inferred",
          evidence: `COMPANY-BASED INFERENCE (not a verified designation, and no opening is confirmed): the company's own name "${company.name || c.company}" states its field ("${named.signal}"); no further company evidence was available.`,
        };
      } else {
        const hasCompany = !!(company.name || c.company);
        role = {
          primary: "Software Engineer",
          additional: [],
          status: "Unverified",
          basis: "default-fallback",
          evidence: hasCompany
            ? `DEFAULT FALLBACK (unverified): the available information does not show that "${company.name || c.company}" is primarily an AI or software company (other industry, or insufficient information), so Software Engineer was applied as the agreed default for software-engineering outreach. This is not evidence about the company or the person.`
            : "DEFAULT FALLBACK (unverified): no company name or readable website is available for this contact, so Software Engineer was applied as the agreed default for software-engineering outreach. This is not evidence about the person or any company.",
        };
      }
    }
    const person = assessPerson(c, company);

    if (c.emailKind === "public-provider") notes.push("Public e-mail provider: the employer cannot be inferred from the address. Company name (if any) is only what the source file states.");
    if (c.emailKind === "legacy-isp") notes.push("Legacy ISP/portal address from an old list: likely stale and not tied to any company website.");
    if (rec) notes.push(...company.notes);
    if (rec && !rec.researched) notes.push("Company website not researched yet.");
    if (c.company && c.emailKind === "company" && companyDomainMismatch(c.company, c.emailDomain)) {
      notes.push(`Stated company "${c.company}" does not resemble the e-mail domain ${c.emailDomain}; kept as given, review before use.`);
    }
    const hint = normalizeDomain(c.domainHint);
    if (hint && hint !== c.emailDomain) notes.push(`Source domain column says ${hint} but the e-mail domain is ${c.emailDomain}; the e-mail domain was researched.`);
    notes.push(...person.notes);
    for (const cf of c.conflicts) notes.push(`Conflict in ${cf.field}: ${cf.values.map((v) => `"${v.value}"`).join(" vs ")}; kept "${cf.chosen}" (higher-priority source).`);
    notes.push(...c.uncertainties);
    if (c.alternateEmails.length) notes.push(`Source lists alternate address(es): ${c.alternateEmails.join(", ")}.`);

    const researched = !!rec?.researched;
    const resolution: MasterContact["ResolutionStatus"] = c.emailKind !== "company" ? "unresolved" : !researched ? "pending-research" : company.status === "Unverified" ? "unresolved" : "resolved";

    return {
      ContactID: contactIdFor(c.email),
      PersonName: c.name,
      PersonDesignation: c.designation,
      PersonEmail: c.email,
      EmailDomain: c.emailDomain,
      CompanyName: company.name || c.company,
      CompanyURL: company.url,
      CompanyDomain: company.status === "Unverified" ? "" : company.domain,
      PrimaryRoleCategory: role.primary,
      AdditionalRoleCategories: role.additional,
      CompanyDescription: company.description,
      HiringEvidence: role.evidence,
      PersonVerificationStatus: person.status,
      CompanyVerificationStatus: company.status,
      RoleVerificationStatus: role.status,
      ResearchSources: rec?.sources ?? [],
      SalutationName: c.name || FALLBACK_SALUTATION,
      CompanyReference: (company.name || c.company) || FALLBACK_COMPANY_REFERENCE,
      RoleBasis: role.primary === "Unverified" ? "" : (role.basis ?? ""),
      SourceFiles: [...new Set(c.sources.map((s) => s.file))],
      SourceLocations: c.sources.map((s) => `${s.file}: ${s.location}`),
      DuplicateGroup: groupOf.get(c.email) ?? "",
      ResearchNotes: [...new Set(notes)].filter(Boolean).join(" | "),
      LastResearchedAt: rec?.researchedAt ?? "",
      ContactKind: c.contactKind,
      EmailKind: c.emailKind,
      AlternateEmails: c.alternateEmails,
      CareersURL: company.careersUrl,
      PersonEvidence: person.evidence,
      Conflicts: c.conflicts,
      ResolutionStatus: resolution,
      SchemaVersion: SCHEMA_VERSION,
    };
  });

  const ids = new Set<string>();
  for (const r of rows) {
    if (ids.has(r.ContactID)) throw new Error(`ContactID collision on ${r.ContactID}`);
    ids.add(r.ContactID);
  }
  return rows;
}

export interface MasterSummary {
  contacts: number;
  people: Record<string, number>;
  companies: Record<string, number>;
  roles: Record<string, number>;
  primaryRoleCounts: Record<string, number>;
  resolution: Record<string, number>;
  contactKinds: Record<string, number>;
  emailKinds: Record<string, number>;
  withVerifiedRole: number;
  uniqueCompanyDomains: number;
  companyDomainsResearched: number;
  companyDomainsPending: number;
}

const tally = <T,>(items: readonly T[], key: (t: T) => string) => {
  const m: Record<string, number> = {};
  for (const i of items) m[key(i)] = (m[key(i)] ?? 0) + 1;
  return m;
};

export function summarise(rows: readonly MasterContact[], companies: ReadonlyMap<string, CompanyRecord>): MasterSummary {
  const recs = [...companies.values()];
  return {
    contacts: rows.length,
    people: tally(rows, (r) => r.PersonVerificationStatus),
    companies: tally(rows, (r) => r.CompanyVerificationStatus),
    roles: tally(rows, (r) => r.RoleVerificationStatus),
    primaryRoleCounts: tally(rows, (r) => r.PrimaryRoleCategory),
    resolution: tally(rows, (r) => r.ResolutionStatus),
    contactKinds: tally(rows, (r) => r.ContactKind),
    emailKinds: tally(rows, (r) => r.EmailKind),
    withVerifiedRole: rows.filter((r) => r.RoleVerificationStatus === "Verified").length,
    uniqueCompanyDomains: recs.length,
    companyDomainsResearched: recs.filter((r) => r.researched).length,
    companyDomainsPending: recs.filter((r) => !r.researched).length,
  };
}

/** Same company identity for two contacts' stated names (used by consumers that group by company). */
export const sameCompany = (a: string, b: string) => !!companyKey(a) && companyKey(a) === companyKey(b);
