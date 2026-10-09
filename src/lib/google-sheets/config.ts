import "server-only";
import { resolveTimezone } from "@/lib/utils/time";
import { SheetsError } from "./errors";

export interface SheetsConfig {
  spreadsheetId: string;
  clientEmail: string;
  privateKey: string;
}

/** Accepts the key as pasted into env files/Vercel: optional quotes and escaped "\n" sequences. */
export function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, "\n");
}

/**
 * Reads and validates server-only configuration. Error messages name the missing variables
 * but never include any value.
 */
export function loadSheetsConfig(env: NodeJS.ProcessEnv = process.env): SheetsConfig {
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  const clientEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const rawKey = env.GOOGLE_PRIVATE_KEY;

  const missing: string[] = [];
  if (!spreadsheetId) missing.push("GOOGLE_SHEETS_SPREADSHEET_ID");
  if (!clientEmail) missing.push("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  if (!rawKey?.trim()) missing.push("GOOGLE_PRIVATE_KEY");
  if (missing.length) {
    throw new SheetsError("not_configured", `Google Sheets is not configured (missing: ${missing.join(", ")}).`);
  }

  const privateKey = normalizePrivateKey(rawKey!);
  const problems: string[] = [];
  if (!/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId!)) problems.push("GOOGLE_SHEETS_SPREADSHEET_ID");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail!)) problems.push("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  if (!privateKey.includes("-----BEGIN PRIVATE KEY-----") || !privateKey.includes("-----END PRIVATE KEY-----")) {
    problems.push("GOOGLE_PRIVATE_KEY");
  }
  if (problems.length) {
    throw new SheetsError("not_configured", `Google Sheets configuration is malformed (check: ${problems.join(", ")}).`);
  }

  return { spreadsheetId: spreadsheetId!, clientEmail: clientEmail!, privateKey };
}

export function appTimezone(env: NodeJS.ProcessEnv = process.env): string {
  return resolveTimezone(env.APP_TIMEZONE);
}
