/** Read-only check of the Outreach Database: tabs, header row, row count, ContactID uniqueness. Usage: --id <id> */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { MASTER_FIELDS } from "../../src/lib/hr-master/types.ts";
import { ROOT, OUT_DIR } from "./paths.mts";
const require = createRequire(import.meta.url);
const { loadEnvConfig } = require(path.join(ROOT, "node_modules/@next/env"));
const { auth, sheets } = require(path.join(ROOT, "node_modules/@googleapis/sheets"));
loadEnvConfig(ROOT, true);
const id = process.argv[process.argv.indexOf("--id") + 1];
if (id === process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim()) throw new Error("production id refused");
let key = (process.env.GOOGLE_PRIVATE_KEY ?? "").trim();
if (/^["'].*["']$/s.test(key)) key = key.slice(1, -1);
const jwt = new auth.JWT({ email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim(), key: key.replace(/\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const api = sheets({ version: "v4", auth: jwt });
const meta = await api.spreadsheets.get({ spreadsheetId: id, fields: "properties.title,sheets.properties(title,gridProperties)" });
console.log("title:", meta.data.properties.title, "| tabs:", JSON.stringify(meta.data.sheets.map((s: { properties: { title: string; gridProperties: { rowCount: number; columnCount: number } } }) => [s.properties.title, s.properties.gridProperties.rowCount, s.properties.gridProperties.columnCount])));
const hdr: string[] = (await api.spreadsheets.values.get({ spreadsheetId: id, range: "'Master Contacts'!1:1" })).data.values[0];
const all: string[][] = (await api.spreadsheets.values.get({ spreadsheetId: id, range: "'Master Contacts'!A2:AF" })).data.values;
const local: Record<string, string | string[]>[] = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "master-contacts.json"), "utf8"));
console.log("header matches schema columns:", JSON.stringify(hdr) === JSON.stringify([...MASTER_FIELDS]), "| columns:", hdr.length);
const col = (n: string) => hdr.indexOf(n);
console.log("data rows:", all.length, "| local master:", local.length, "| unique ContactIDs:", new Set(all.map((r) => r[col("ContactID")])).size);
const localById = new Map(local.map((r) => [r.ContactID as string, r]));
let mismatches = 0;
const counts: Record<string, number> = {};
const basis: Record<string, number> = {};
for (const r of all) {
  const l = localById.get(r[col("ContactID")]);
  if (!l) { mismatches++; continue; }
  for (const f of ["PrimaryRoleCategory", "RoleBasis", "RoleVerificationStatus", "PersonEmail", "SalutationName", "CompanyReference"]) if ((r[col(f)] ?? "") !== l[f]) mismatches++;
  counts[r[col("PrimaryRoleCategory")]] = (counts[r[col("PrimaryRoleCategory")]] ?? 0) + 1;
  const b = r[col("RoleBasis")] ?? "";
  basis[b || "(none)"] = (basis[b || "(none)"] ?? 0) + 1;
}
console.log("row-level mismatches vs local master:", mismatches);
console.log("sheet PrimaryRoleCategory counts:", JSON.stringify(counts));
console.log("sheet RoleBasis counts:", JSON.stringify(basis));
