/**
 * ADDITIVE production step: adds the five Connections / Group Chat tabs (with header rows) to the production
 * spreadsheet if they are missing. It never writes to, clears, or reorders any existing tab; it snapshots every
 * existing tab before and after and fails if any content differs.
 *
 *   node --conditions=react-server --experimental-strip-types --no-warnings scripts/add-prod-tabs.mts
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { TABS } from "../src/lib/google-sheets/schema.ts";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const { loadEnvConfig } = require(path.join(root, "node_modules/@next/env"));
const { auth, sheets } = require(path.join(root, "node_modules/@googleapis/sheets"));
loadEnvConfig(root, true);

const id = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
let key = (process.env.GOOGLE_PRIVATE_KEY ?? "").trim();
if (/^["'].*["']$/s.test(key)) key = key.slice(1, -1);
key = key.replace(/\n/g, "\n");
if (!id || !email || !key) throw new Error("production credentials missing");

const api = sheets({ version: "v4", auth: new auth.JWT({ email, key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] }) });
const NEW = ["connections", "chatMessages", "chatFiles", "chatReads", "callSignals"] as const;

async function snapshot() {
  const meta = await api.spreadsheets.get({ spreadsheetId: id });
  const out: Record<string, { rows: number; hash: string }> = {};
  for (const s of meta.data.sheets ?? []) {
    const title = s.properties?.title as string;
    if (NEW.some((k) => TABS[k].name === title)) continue;
    const res = await api.spreadsheets.values.get({ spreadsheetId: id, range: title });
    const values = res.data.values ?? [];
    out[title] = { rows: values.length, hash: createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16) };
  }
  return { tabs: (meta.data.sheets ?? []).map((s: { properties?: { title?: string } }) => s.properties?.title), out };
}

const before = await snapshot();
console.log("BEFORE", JSON.stringify(before));
const missing = NEW.map((k) => TABS[k]).filter((t) => !before.tabs.includes(t.name));
if (missing.length) {
  await api.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: missing.map((t) => ({ addSheet: { properties: { title: t.name } } })) } });
  for (const t of missing) {
    await api.spreadsheets.values.update({ spreadsheetId: id, range: `${t.name}!A1`, valueInputOption: "RAW", requestBody: { values: [[...t.headers]] } });
    console.log("ADDED", t.name, t.headers.join(","));
  }
}
const after = await snapshot();
console.log("AFTER ", JSON.stringify(after));
if (JSON.stringify(before.out) !== JSON.stringify(after.out)) throw new Error("EXISTING TABS CHANGED");
console.log("existing tabs identical: true");
