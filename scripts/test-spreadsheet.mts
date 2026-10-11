/**
 * Creates / verifies / resets the DISPOSABLE test spreadsheet used by the live Google Sheets
 * integration tests and the isolated browser E2E tests.
 *
 *   npm run sheets:test-setup            verify the test spreadsheet and prepare it (tabs, headers, Members rows)
 *   npm run sheets:test-setup -- --reset  also clear its data rows (Members rows are re-seeded)
 *
 * One-time manual step (the service account is forbidden from CREATING spreadsheets - HTTP 403 - although
 * it can read and write spreadsheets shared with it, so this script never creates one):
 *   1. In Google Sheets create a NEW spreadsheet titled exactly starting with "JobSync TEST"
 *      (e.g. "JobSync TEST (disposable)"). It must be a different file from "JobSync Database".
 *   2. Share it with the service-account email as Editor.
 *   3. Put its ID in .env.test.local:   GOOGLE_TEST_SPREADSHEET_ID=<id from its URL>
 *   4. Run this script. It adds the four tabs, headers and the three Members rows if missing.
 *
 * Safety:
 *  - It reads Google credentials from .env.local (same service account) but NEVER touches the
 *    production spreadsheet: it refuses to run if the test ID equals GOOGLE_SHEETS_SPREADSHEET_ID.
 *  - The test spreadsheet ID lives in .env.test.local (gitignored) as GOOGLE_TEST_SPREADSHEET_ID.
 *  - Nothing secret is printed.
 *
 * Run with: node --conditions=react-server --experimental-strip-types scripts/test-spreadsheet.mts
 * (the flag lets the schema module's `server-only` import resolve outside Next.js).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { TABS } from "../src/lib/google-sheets/schema.ts";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const { loadEnvConfig } = require(path.join(root, "node_modules/@next/env"));
const { auth, sheets } = require(path.join(root, "node_modules/@googleapis/sheets"));

const ENV_TEST = path.join(root, ".env.test.local");

loadEnvConfig(root, true);

const prodId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
const rawKey = process.env.GOOGLE_PRIVATE_KEY ?? "";
if (!email || !rawKey) {
  console.error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY in .env.local");
  process.exit(1);
}
let key = rawKey.trim();
if (/^["'].*["']$/s.test(key)) key = key.slice(1, -1);
key = key.replace(/\\n/g, "\n");

function readTestId(): string | undefined {
  if (!fs.existsSync(ENV_TEST)) return undefined;
  const m = /^GOOGLE_TEST_SPREADSHEET_ID=(.+)$/m.exec(fs.readFileSync(ENV_TEST, "utf8"));
  return m?.[1].trim();
}

const jwt = new auth.JWT({ email, key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const api = sheets({ version: "v4", auth: jwt });
const reset = process.argv.includes("--reset");

const MEMBER_ROWS = [
  ["anni", "Anni", "/assets/anni.jpeg", "TRUE"],
  ["lukky", "Lukky", "/assets/lukky.jpeg", "TRUE"],
  ["rishii", "Rishii", "/assets/rishii.jpeg", "TRUE"],
];

function safeError(raw: unknown): string {
  const err = raw as { response?: { status?: number; data?: { error?: { status?: string; message?: unknown } } } };
  const e = err?.response?.data?.error;
  return JSON.stringify({ httpStatus: err?.response?.status, status: e?.status, message: typeof e?.message === "string" ? e.message.slice(0, 300) : undefined });
}

async function ensureTabs(spreadsheetId: string, existing: string[]) {
  const missing = Object.values(TABS).map((t) => t.name).filter((n) => !existing.includes(n));
  if (missing.length === 0) return;
  await api.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
  });
  console.log(`Added missing tabs: ${missing.join(", ")}`);
}

async function headersOk(spreadsheetId: string): Promise<boolean> {
  for (const t of Object.values(TABS)) {
    const r = await api.spreadsheets.values.get({ spreadsheetId, range: `${t.name}!1:1` });
    const row = (r.data.values?.[0] ?? []).map((c: unknown) => String(c).trim());
    if (JSON.stringify(row) !== JSON.stringify([...t.headers, ...(("optionalHeaders" in t ? t.optionalHeaders : []) as readonly string[])])) return false;
  }
  return true;
}

async function writeHeadersAndMembers(spreadsheetId: string) {
  for (const t of Object.values(TABS)) {
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `${t.name}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [[...t.headers, ...(("optionalHeaders" in t ? t.optionalHeaders : []) as readonly string[])]] },
    });
  }
  await api.spreadsheets.values.update({
    spreadsheetId,
    range: "Members!A2",
    valueInputOption: "RAW",
    requestBody: { values: MEMBER_ROWS },
  });
}

async function clearData(spreadsheetId: string) {
  for (const t of Object.values(TABS)) {
    await api.spreadsheets.values.clear({ spreadsheetId, range: `${t.name}!A2:Z` });
  }
  await api.spreadsheets.values.update({
    spreadsheetId,
    range: "Members!A2",
    valueInputOption: "RAW",
    requestBody: { values: MEMBER_ROWS },
  });
}

async function main() {
  const id = readTestId();

  if (id) {
    if (id === prodId) {
      console.error("REFUSING: GOOGLE_TEST_SPREADSHEET_ID equals the production spreadsheet ID.");
      process.exit(2);
    }
    const meta = await api.spreadsheets.get({ spreadsheetId: id, fields: "properties.title,sheets.properties.title" });
    const title = meta.data.properties?.title ?? "";
    if (!title.startsWith("JobSync TEST")) {
      console.error("REFUSING: the configured test spreadsheet is not titled 'JobSync TEST ...'.");
      process.exit(2);
    }
    const existing = (meta.data.sheets ?? []).map((s) => s.properties?.title as string);
    console.log(`Test spreadsheet reachable. Tabs: ${existing.join(", ")}`);
    await ensureTabs(id, existing);
    if (!(await headersOk(id))) {
      await writeHeadersAndMembers(id);
      console.log("Headers and Members rows written to the test spreadsheet.");
    }
    if (reset) {
      await clearData(id);
      console.log("Test spreadsheet data rows cleared; Members re-seeded.");
    }
    return;
  }

  console.error(
    [
      "GOOGLE_TEST_SPREADSHEET_ID is not set in .env.test.local, so nothing was done.",
      "This script never creates spreadsheets and never falls back to the production spreadsheet.",
      "Create a spreadsheet titled 'JobSync TEST (disposable)', share it with the service account as Editor,",
      "add GOOGLE_TEST_SPREADSHEET_ID=<id from its URL> to .env.test.local, then run this script again.",
    ].join("\n"),
  );
  process.exit(3);
}

main().catch((err) => {
  console.error("FAILED:", safeError(err));
  console.error("Check that the test spreadsheet is shared with the service account as Editor and the ID is correct.");
  process.exit(1);
});
