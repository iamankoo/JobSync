/**
 * "Outreach Database" spreadsheet helper. Uses JobSync's EXISTING service-account credentials from .env.local (no new key).
 * It never writes to the production spreadsheet: it refuses any spreadsheet id equal to GOOGLE_SHEETS_SPREADSHEET_ID.
 *
 *   --check            read-only: confirm the integration can read production (title only) and report what it may do
 *   --create           try to create a new spreadsheet titled "Outreach Database"
 *   --id <id> --push   write data/hr-master/master-contacts.csv into an EXISTING sheet titled "Outreach Database"
 *                      that has been shared with the service account as Editor (tab "Master Contacts")
 *
 * The service account is forbidden from CREATING spreadsheets (HTTP 403, same as scripts/test-spreadsheet.mts documents), so
 * --create is expected to fail; --push is the supported route once an empty "Outreach Database" sheet exists and is shared.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/hr-master/create-outreach-sheet.mts --check
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseCsv } from "../../src/lib/hr-master/csv.ts";
import { OUT_DIR, ROOT } from "./paths.mts";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require(path.join(ROOT, "node_modules/@next/env"));
const { auth, sheets } = require(path.join(ROOT, "node_modules/@googleapis/sheets"));
loadEnvConfig(ROOT, true);

const args = process.argv.slice(2);
const prodId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim() ?? "";
let key = (process.env.GOOGLE_PRIVATE_KEY ?? "").trim();
if (/^["'].*["']$/s.test(key)) key = key.slice(1, -1);
key = key.replace(/\\n/g, "\n");
const jwt = new auth.JWT({ email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim(), key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const api = sheets({ version: "v4", auth: jwt });

interface GoogleErr {
  response?: { status?: number; data?: { error?: { status?: string; message?: string } } };
  message?: string;
}
const safe = (e: unknown) => {
  const g = e as GoogleErr;
  return JSON.stringify({ httpStatus: g.response?.status, status: g.response?.data?.error?.status, message: String(g.response?.data?.error?.message ?? g.message).slice(0, 200) });
};

if (args.includes("--check") || args.includes("--create")) {
  try {
    const r = await api.spreadsheets.get({ spreadsheetId: prodId, fields: "properties.title" });
    console.log("READ access to the production spreadsheet: OK, title =", r.data.properties?.title);
  } catch (e) {
    console.log("READ access check failed:", safe(e));
  }
}

if (args.includes("--create")) {
  try {
    const c = await api.spreadsheets.create({ requestBody: { properties: { title: "Outreach Database" } }, fields: "spreadsheetId,spreadsheetUrl" });
    console.log("CREATED:", c.data.spreadsheetUrl);
  } catch (e) {
    console.log("CREATE failed:", safe(e));
  }
}

if (args.includes("--push")) {
  const id = args[args.indexOf("--id") + 1]?.trim();
  if (!id || id.startsWith("--")) throw new Error("--push needs --id <spreadsheet id>");
  if (id === prodId) throw new Error("Refusing: that is the production spreadsheet.");
  const meta = await api.spreadsheets.get({ spreadsheetId: id, fields: "properties.title,sheets.properties" });
  if (meta.data.properties?.title !== "Outreach Database") throw new Error(`Refusing: spreadsheet is titled "${meta.data.properties?.title}", expected "Outreach Database".`);
  const tab = "Master Contacts";
  if (!meta.data.sheets?.some((s: { properties?: { title?: string } }) => s.properties?.title === tab)) {
    await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] } });
  }
  const rows = parseCsv(fs.readFileSync(path.join(OUT_DIR, "master-contacts.csv"), "utf8")).map((r) => r.map((c) => (c.length > 40_000 ? c.slice(0, 40_000) : c)));
  const after = await api.spreadsheets.get({ spreadsheetId: id, fields: "sheets.properties" });
  const sheetId = after.data.sheets?.find((s: { properties?: { title?: string } }) => s.properties?.title === tab)?.properties?.sheetId;
  await api.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount: rows.length + 10, columnCount: rows[0].length, frozenRowCount: 1 } }, fields: "gridProperties(rowCount,columnCount,frozenRowCount)" } }] },
  });
  await api.spreadsheets.values.clear({ spreadsheetId: id, range: `'${tab}'` });
  const BATCH = 1500;
  for (let i = 0; i < rows.length; i += BATCH) {
    await api.spreadsheets.values.update({
      spreadsheetId: id,
      range: `'${tab}'!A${i + 1}`,
      valueInputOption: "RAW", // never let Sheets interpret a value as a formula
      requestBody: { values: rows.slice(i, i + BATCH) },
    });
    console.log(`wrote rows ${i + 1}-${Math.min(i + BATCH, rows.length)} of ${rows.length}`);
  }
}
