/**
 * Setup of the OUTREACH DATABASE spreadsheet (never the production sheet): adds the outreach tabs with their headers if they are
 * missing, and EXTENDS an older, shorter header row of an existing tab (additive: data rows and Master Contacts are never touched).
 *   node --experimental-strip-types --no-warnings scripts/outreach/setup-outreach-tabs.mts --id <Outreach Database spreadsheet id>
 */
import path from "node:path";
import { createRequire } from "node:module";
import { COUNTER_HEADERS, EXCLUSION_HEADERS, SEND_LEDGER_HEADERS, STATE_HEADERS, TRACKING_HEADERS } from "../../src/lib/outreach/headers.ts";
import { COUNTERS_TAB, EXCLUSIONS_TAB, SEND_LEDGER_TAB, STATE_TAB, TRACKING_TAB } from "../../src/lib/outreach/types.ts";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../..");
const { loadEnvConfig } = require(path.join(ROOT, "node_modules/@next/env"));
const { auth, sheets } = require(path.join(ROOT, "node_modules/@googleapis/sheets"));
loadEnvConfig(ROOT, true);

const id = process.argv[process.argv.indexOf("--id") + 1];
if (!id || id.startsWith("--")) throw new Error("--id <spreadsheet id> is required");
if (id === process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim()) throw new Error("Refusing: that is the production spreadsheet.");
let key = (process.env.GOOGLE_PRIVATE_KEY ?? "").trim();
if (/^["'].*["']$/s.test(key)) key = key.slice(1, -1);
const jwt = new auth.JWT({ email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim(), key: key.replace(/\\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const api = sheets({ version: "v4", auth: jwt });

const meta = await api.spreadsheets.get({ spreadsheetId: id, fields: "properties.title,sheets.properties.title" });
if (meta.data.properties?.title !== "Outreach Database") throw new Error(`Refusing: spreadsheet is titled "${meta.data.properties?.title}".`);
const have = new Set<string>((meta.data.sheets ?? []).map((s: { properties?: { title?: string } }) => s.properties?.title ?? ""));
const wanted: [string, readonly string[]][] = [
  [TRACKING_TAB, TRACKING_HEADERS], [COUNTERS_TAB, COUNTER_HEADERS], [STATE_TAB, STATE_HEADERS], [SEND_LEDGER_TAB, SEND_LEDGER_HEADERS], [EXCLUSIONS_TAB, EXCLUSION_HEADERS],
];
const missing = wanted.filter(([t]) => !have.has(t));
if (missing.length) {
  await api.spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: { requests: missing.map(([title, h]) => ({ addSheet: { properties: { title, gridProperties: { rowCount: 20000, columnCount: h.length, frozenRowCount: 1 } } } })) },
  });
}
for (const [tab, headers] of wanted) {
  const first: string[] = (await api.spreadsheets.values.get({ spreadsheetId: id, range: `'${tab}'!1:1` })).data.values?.[0] ?? [];
  const blank = !first.some((c) => c?.trim());
  const conflict = first.some((c, i) => c?.trim() && c.trim() !== headers[i]);
  if (conflict) throw new Error(`Tab "${tab}" has a header row that does not match; refusing to touch it.`);
  if (!blank && headers.every((h, i) => first[i]?.trim() === h)) { console.log(`${tab}: header already current`); continue; }
  // Widen the grid if the header grew, then write the (blank or prefix-matching) header row. Data rows are not touched.
  const grid = (await api.spreadsheets.get({ spreadsheetId: id, fields: "sheets.properties" })).data.sheets.find((s: { properties: { title: string } }) => s.properties.title === tab).properties;
  if (grid.gridProperties.columnCount < headers.length) {
    await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: grid.sheetId, gridProperties: { columnCount: headers.length } }, fields: "gridProperties.columnCount" } }] } });
  }
  await api.spreadsheets.values.update({ spreadsheetId: id, range: `'${tab}'!A1`, valueInputOption: "RAW", requestBody: { values: [[...headers]] } });
  console.log(`${tab}: ${blank ? "created" : "extended"} with ${headers.length} columns`);
}
