/**
 * Stage 4: combine the deduplicated contacts with the per-domain research into the Master Contact Database and write every
 * output file. Safe to run at any time (also while research is still in progress: unresearched domains are reported as
 * "pending-research"). Local files only; no network, no Sheets, no Gmail.
 *
 *   node --experimental-strip-types --no-warnings scripts/hr-master/build-master.mts
 */
import fs from "node:fs";
import path from "node:path";
import { toCsv } from "../../src/lib/hr-master/csv.ts";
import type { DedupeResult } from "../../src/lib/hr-master/dedupe.ts";
import { buildCompanyRecords, buildMaster, summarise, type AboutPage } from "../../src/lib/hr-master/master.ts";
import { CSV_COLUMNS, validateMaster } from "../../src/lib/hr-master/schema.ts";
import { parseResearchJsonl } from "../../src/lib/hr-master/research.ts";
import { importReadiness } from "../../src/lib/hr-master/connections-mapping.ts";
import { SOURCE_FILES, type CompanyResearch, type MasterContact } from "../../src/lib/hr-master/types.ts";
import { OUT_DIR, WORK_DIR } from "./paths.mts";

const deduped = JSON.parse(fs.readFileSync(path.join(WORK_DIR, "deduped.json"), "utf8")) as DedupeResult;

const researchFile = path.join(WORK_DIR, "domain-research.jsonl");
const research = fs.existsSync(researchFile) ? parseResearchJsonl(fs.readFileSync(researchFile, "utf8")) : new Map<string, CompanyResearch>();

const aboutFile = path.join(WORK_DIR, "about-research.jsonl");
const about = new Map<string, AboutPage>();
if (fs.existsSync(aboutFile)) {
  for (const line of fs.readFileSync(aboutFile, "utf8").split("\n")) {
    try {
      const a = JSON.parse(line) as AboutPage;
      if (a.domain) about.set(a.domain, a);
    } catch {
      /* partial line */
    }
  }
}
const companies = buildCompanyRecords(deduped.contacts, research, about);
const rows = buildMaster(deduped.contacts, deduped.groups, companies);
const issues = validateMaster(rows);
if (issues.length) {
  console.error(`SCHEMA VALIDATION FAILED: ${issues.length} issue(s). First 10:`);
  for (const i of issues.slice(0, 10)) console.error(`  row ${i.row} ${i.contactId}: ${i.problem}`);
  process.exit(1);
}

const write = (name: string, content: string) => fs.writeFileSync(path.join(OUT_DIR, name), content, "utf8");
const cell = (v: unknown): string => (Array.isArray(v) ? (v.length && typeof v[0] === "object" ? JSON.stringify(v) : v.join(" | ")) : String(v ?? ""));
const csvRows = (list: readonly MasterContact[]) => list.map((r) => CSV_COLUMNS.map((c) => cell((r as unknown as Record<string, unknown>)[c])));

write("master-contacts.json", JSON.stringify(rows));
write("master-contacts.csv", toCsv(CSV_COLUMNS, csvRows(rows)));
const unresolved = rows.filter((r) => r.ResolutionStatus !== "resolved");
write("unresolved-contacts.csv", toCsv(CSV_COLUMNS, csvRows(unresolved)));
write("companies.json", JSON.stringify([...companies.values()]));
write("invalid-records.json", JSON.stringify(deduped.invalid, null, 1));
write("review-duplicate-groups.json", JSON.stringify(deduped.groups, null, 1));
write("conflicts.json", JSON.stringify(rows.filter((r) => r.Conflicts.length).map((r) => ({ ContactID: r.ContactID, PersonEmail: r.PersonEmail, Conflicts: r.Conflicts })), null, 1));

const summary = summarise(rows, companies);
const importable = rows.filter((r) => importReadiness(r).importable).length;
const stats = deduped.stats;
const pct = (n: number) => `${n} (${((n / rows.length) * 100).toFixed(1)}%)`;
const table = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join("\n");
const fileTable = SOURCE_FILES.map((f) => `| ${f} | ${stats.rawBySource[f] ?? 0} | ${stats.validBySource[f] ?? 0} |`).join("\n");
const generated = new Date().toISOString();
const basisCounts: Record<string, number> = {};
for (const r of rows) basisCounts[r.RoleBasis || "(none: Unverified)"] = (basisCounts[r.RoleBasis || "(none: Unverified)"] ?? 0) + 1;

write(
  "research-summary.md",
  `# HR Master Database - research summary

Generated ${generated}. Schema version 1. Local files only; nothing here has been imported anywhere.

## Extraction and deduplication

| Source file | Raw records | Valid e-mail records |
|---|---|---|
${fileTable}
| **Total** | **${stats.rawTotal}** | **${stats.validEmailRecords}** |

- Invalid e-mail records (kept in invalid-records.json, not in the master): **${stats.invalidRecords}**
- Unique contacts (one per normalised e-mail address): **${stats.uniqueContacts}**
- Duplicate records merged (same e-mail): **${stats.duplicateRecordsMerged}** (${stats.contactsInMultipleFiles} contacts appear in more than one file)
- Contacts with conflicting values between sources (documented, nothing discarded silently): **${stats.contactsWithConflicts}** (${stats.conflictCount} field conflicts, see conflicts.json)
- Possible-duplicate review groups (same name + same organisation, different e-mail; NOT merged): **${stats.duplicateGroups}** groups covering ${stats.contactsInDuplicateGroups} contacts
- Names shared by people at different organisations (correctly kept apart): ${stats.sameNameDifferentCompanyNames}

## Research coverage

- Company-owned e-mail domains: **${summary.uniqueCompanyDomains}**; researched: **${summary.companyDomainsResearched}**; still pending: **${summary.companyDomainsPending}**
- Contacts by resolution: ${Object.entries(summary.resolution).map(([k, v]) => `${k} ${v}`).join(", ")}

### Person verification
| Status | Contacts |
|---|---|
${table(summary.people)}

### Company verification
| Status | Contacts |
|---|---|
${table(summary.companies)}

### Role verification
| Status | Contacts |
|---|---|
${table(summary.roles)}

Contacts with a **Verified** role category: **${summary.withVerifiedRole}** (${pct(summary.withVerifiedRole)}).
Contacts that meet the proposed Part 2 import bar (see connections-mapping.ts \`importReadiness\`): **${importable}**.

### Role basis (how the category was reached)
| Basis | Contacts |
|---|---|
${table(basisCounts)}

"company-inferred" = classified only from what the company mainly does (software or AI) on its own homepage/About page; it is not an individual designation and confirms no opening.

### Primary role category
| Category | Contacts |
|---|---|
${table(summary.primaryRoleCounts)}

### Contact and e-mail kinds
| Contact kind | Contacts |
|---|---|
${table(summary.contactKinds)}

| E-mail kind | Contacts |
|---|---|
${table(summary.emailKinds)}

See README.md for methodology, definitions and limitations.
`,
);

console.log(JSON.stringify({ rows: rows.length, validationIssues: 0, summary, importable }, null, 2));
