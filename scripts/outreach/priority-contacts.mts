/**
 * Plans (and, only with explicit approval, applies) the PRIORITY IMPORT of a new contact list into the Outreach Database.
 *
 *   DRY RUN (default; READ-ONLY, writes nothing anywhere except the report files in --out):
 *     node --experimental-strip-types --no-warnings scripts/outreach/priority-contacts.mts --xlsx Mail-Data/new-data.xlsx --id <Outreach Database id> --out <folder>
 *
 *   APPLY (writes to the Outreach Database: creates the "Priority Contacts" tab and appends the planned rows; NEVER Master Contacts, the tracking
 *   tabs or the production JobSync spreadsheet). Needs BOTH flags, and refuses if the tab already holds rows:
 *     ... --apply --i-have-owner-approval
 *
 * What the plan decides is in src/lib/hr-master/priority-plan.ts. Location / visa / sponsorship wording is never used to exclude a contact.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { MASTER_FIELDS } from "../../src/lib/hr-master/types.ts";
import { normalizeEmail } from "../../src/lib/hr-master/normalize.ts";
import { orderPlan, planPriorityContacts, priorityTabRows, type NewDataRow } from "../../src/lib/hr-master/priority-plan.ts";
import { readFirstSheet } from "./xlsx-lite.mts";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../..");
const { loadEnvConfig } = require(path.join(ROOT, "node_modules/@next/env"));
const { auth, sheets } = require(path.join(ROOT, "node_modules/@googleapis/sheets"));
loadEnvConfig(ROOT, true);

const arg = (n: string) => { const i = process.argv.indexOf(n); return i < 0 ? undefined : process.argv[i + 1]; };
const flag = (n: string) => process.argv.includes(n);
const xlsx = arg("--xlsx");
const id = arg("--id");
const out = arg("--out") ?? path.join(ROOT, "priority-plan-out");
const apply = flag("--apply");
if (!xlsx || !id) throw new Error("--xlsx <file> and --id <Outreach Database spreadsheet id> are required");
if (apply && !flag("--i-have-owner-approval")) throw new Error("--apply also needs --i-have-owner-approval (the owner must approve the import first)");
const prodId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim() ?? "";
if (id === prodId) throw new Error("Refusing: that is the production spreadsheet, not the Outreach Database.");

let key = (process.env.GOOGLE_PRIVATE_KEY ?? "").trim();
if (/^["'].*["']$/s.test(key)) key = key.slice(1, -1);
const jwt = new auth.JWT({ email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim(), key: key.replace(/\\n/g, "\n"), scopes: [apply ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly"] });
const api = sheets({ version: "v4", auth: jwt });
const get = async (spreadsheetId: string, range: string): Promise<string[][]> => (await api.spreadsheets.values.get({ spreadsheetId, range })).data.values ?? [];

// ---- the new contact list (read-only copy of the file's contents) --------------------------------------------------------------------
const grid = readFirstSheet(xlsx);
const headerAt = grid.findIndex((r) => r.includes("Company") && r.includes("Public contact email"));
if (headerAt < 0) throw new Error("Could not find the header row (Company, Public contact email, ...)");
const header = grid[headerAt];
const col = (n: string) => header.indexOf(n);
const rows: NewDataRow[] = grid.slice(headerAt + 1).map((r, i) => ({
  sourceRow: headerAt + 2 + i, company: (r[col("Company")] ?? "").trim(), email: (r[col("Public contact email")] ?? "").trim(), openRoles: r[col("Open roles / YC batch")] ?? "",
  founderProfile: r[col("Founder / company profile")] ?? "", hiringChecked: r[col("Hiring checked")] ?? "", provenance: r[col("Contact provenance")] ?? "",
})).filter((r) => r.company || r.email);

// ---- what JobSync already has (read-only) -------------------------------------------------------------------------------------------
const objs = (g: string[][]) => g.slice(1).map((r) => Object.fromEntries((g[0] ?? []).map((c, i) => [c, r[i] ?? ""])));
const tracking = objs(await get(id, "'Added in Outreach Emails'!A:AE"));
const connections = objs(await get(prodId, "Connections!A:P"));
const exclusions = (await get(id, "'Outreach Exclusions'!A:D")).slice(1).map((r) => ({ value: r[0] ?? "", reason: r[1] ?? "" }));
const masterHeader = (await get(id, "'Master Contacts'!1:1"))[0] ?? [];
const L = (n: string) => { const i = masterHeader.indexOf(n); if (i < 0) throw new Error(`Master Contacts has no ${n} column`); let s = ""; for (let k = i + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s; return s; };
const masterIds = await get(id, `'Master Contacts'!${L("ContactID")}2:${L("ContactID")}`);
const masterEmails = await get(id, `'Master Contacts'!${L("PersonEmail")}2:${L("PersonEmail")}`);
const masterIdByEmail = new Map<string, string>(masterEmails.map((r, i) => [normalizeEmail(r[0] ?? "").email, masterIds[i]?.[0] ?? ""] as [string, string]));

const imported = tracking.filter((t) => t.Source === "outreach-database" && t.ImportStatus === "added" && t.LastError !== "linked-existing");
const importedCount = new Set(imported.map((t) => t.ContactID)).size;
const plan = planPriorityContacts(rows, {
  trackedEmails: new Set(tracking.map((t) => normalizeEmail(t.Email).email)), trackedIds: new Set(tracking.map((t) => t.ContactID)),
  connectionEmails: new Set(connections.map((c) => normalizeEmail(c.Email ?? "").email).filter(Boolean)), masterIdByEmail, exclusions,
});
const ordered = orderPlan(plan, importedCount + 1);
const tab = priorityTabRows(ordered);

fs.mkdirSync(out, { recursive: true });
const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
fs.writeFileSync(path.join(out, "priority-plan.csv"), ["position,sourceRow,company,email,action,contactId,role,segment", ...ordered.map((o) => [o.position, o.sourceRow, o.company, o.email, o.status === "promote" ? "PROMOTE existing Master row" : "ADD", o.contactId, o.role, o.segment].map(q).join(","))].join("\n"));
fs.writeFileSync(path.join(out, "priority-skipped.json"), JSON.stringify(plan.filter((p) => !ordered.some((o) => o.sourceRow === p.sourceRow)).map((p) => ({ sourceRow: p.sourceRow, company: p.company, email: p.email, status: p.status, reasons: p.reasons })), null, 1));
fs.writeFileSync(path.join(out, "priority-tab-preview.csv"), tab.map((r) => r.map(q).join(",")).join("\n"));
const by: Record<string, number> = {};
for (const p of plan) by[p.status] = (by[p.status] ?? 0) + 1;
console.log(JSON.stringify({ fileRows: rows.length, importedSoFar: importedCount, outcome: by, priorityContacts: ordered.length, positions: ordered.length ? `${ordered[0].position}-${ordered.at(-1)!.position}` : "-", reportFolder: out }, null, 1));

if (!apply) {
  console.log("DRY RUN: nothing was written to Google Sheets.");
} else {
  const TAB = "Priority Contacts";
  const meta = await api.spreadsheets.get({ spreadsheetId: id, fields: "properties.title,sheets.properties.title" });
  if (meta.data.properties?.title !== "Outreach Database") throw new Error(`Refusing: spreadsheet is titled "${meta.data.properties?.title}".`);
  const have = new Set<string>((meta.data.sheets ?? []).map((s: { properties?: { title?: string } }) => s.properties?.title ?? ""));
  if (have.has(TAB)) {
    const existing = await get(id, `'${TAB}'!A:A`);
    if (existing.length > 1) throw new Error(`Refusing: "${TAB}" already holds ${existing.length - 1} row(s).`);
  } else {
    await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ addSheet: { properties: { title: TAB, gridProperties: { rowCount: Math.max(1000, tab.length + 100), columnCount: MASTER_FIELDS.length, frozenRowCount: 1 } } } }] } });
  }
  await api.spreadsheets.values.update({ spreadsheetId: id, range: `'${TAB}'!A1`, valueInputOption: "RAW", requestBody: { values: tab } });
  console.log(`APPLIED: "${TAB}" now holds ${tab.length - 1} priority row(s).`);
}
