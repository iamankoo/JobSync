import fs from "node:fs";
import path from "node:path";

/**
 * Environment for the LIVE tests (real Google Sheets API against a DISPOSABLE test spreadsheet).
 *
 * Credentials come from .env.local (same service account as the app). The spreadsheet the tests
 * may touch comes ONLY from GOOGLE_TEST_SPREADSHEET_ID in .env.test.local (gitignored) and must
 * differ from the production GOOGLE_SHEETS_SPREADSHEET_ID. Nothing here ever prints a secret.
 */
const ROOT = path.resolve(__dirname, "..", "..");

/** Minimal .env parser: KEY=VALUE, optional quotes, "\n" escapes inside double quotes, # comments. */
export function parseEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1).replace(/\\n/g, "\n");
    else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export interface LiveEnv {
  /** Service-account credentials (from .env.local). */
  email?: string;
  privateKey?: string;
  /** The disposable test spreadsheet (from .env.test.local). */
  testId?: string;
  /** Production ID, used ONLY to guarantee the tests never use it and to snapshot it read-only. */
  prodId?: string;
  /** Why live tests cannot run, if they cannot. */
  unavailable?: string;
}

export function loadLiveEnv(): LiveEnv {
  const local = parseEnvFile(path.join(ROOT, ".env.local"));
  const test = parseEnvFile(path.join(ROOT, ".env.test.local"));
  const email = local.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = local.GOOGLE_PRIVATE_KEY?.trim();
  const prodId = local.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  const testId = test.GOOGLE_TEST_SPREADSHEET_ID?.trim();

  const env: LiveEnv = { email, privateKey, testId, prodId };
  if (!email || !privateKey) env.unavailable = "Service-account credentials are not in .env.local.";
  else if (!testId) env.unavailable = "GOOGLE_TEST_SPREADSHEET_ID is not set in .env.test.local (see scripts/test-spreadsheet.mts).";
  else if (testId === prodId) env.unavailable = "REFUSING: the test spreadsheet ID equals the production spreadsheet ID.";
  return env;
}

/** Throws unless it is safe to write: a distinct test spreadsheet must be configured. */
export function requireSafeTestEnv(): Required<Pick<LiveEnv, "email" | "privateKey" | "testId">> & { prodId?: string } {
  const env = loadLiveEnv();
  if (env.unavailable) throw new Error(env.unavailable);
  return { email: env.email!, privateKey: env.privateKey!, testId: env.testId!, prodId: env.prodId };
}

/** Env vars to give the app/server so it talks to the TEST spreadsheet only. */
export function testServerEnv(): Record<string, string> {
  const { email, privateKey, testId } = requireSafeTestEnv();
  return {
    GOOGLE_SHEETS_SPREADSHEET_ID: testId,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: email,
    GOOGLE_PRIVATE_KEY: privateKey,
  };
}
