/** READ-ONLY: confirms the three outreach tabs exist with the expected header rows and no data rows. --id <Outreach Database id> */
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
if (id === process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim()) throw new Error("production id refused");
let key = (process.env.GOOGLE_PRIVATE_KEY ?? "").trim();
if (/^["'].*["']$/s.test(key)) key = key.slice(1, -1);
const jwt = new auth.JWT({ email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim(), key: key.replace(/\n/g, "\n"), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const api = sheets({ version: "v4", auth: jwt });
for (const [tab, headers] of [[TRACKING_TAB, TRACKING_HEADERS], [COUNTERS_TAB, COUNTER_HEADERS], [STATE_TAB, STATE_HEADERS], [SEND_LEDGER_TAB, SEND_LEDGER_HEADERS], [EXCLUSIONS_TAB, EXCLUSION_HEADERS]] as const) {
  const v: string[][] = (await api.spreadsheets.values.get({ spreadsheetId: id, range: `'${tab}'!A:AZ` })).data.values ?? [];
  console.log(`${tab}: header ok=${JSON.stringify(v[0]) === JSON.stringify([...headers])} columns=${v[0]?.length} dataRows=${v.length - 1}`);
}
