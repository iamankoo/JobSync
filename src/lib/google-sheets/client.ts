import "server-only";
import { auth, sheets as sheetsApi } from "@googleapis/sheets";
import { loadSheetsConfig, type SheetsConfig } from "./config";
import { SheetsError } from "./errors";
import { memorySheets } from "./memory-client";
import { invalidateTableCache } from "./table";

/** The only operations the data layer needs. Small on purpose so it can be faked in tests. */
export interface SheetsClient {
  getValues(range: string): Promise<string[][]>;
  appendValues(range: string, rows: string[][]): Promise<void>;
  updateValues(range: string, rows: string[][]): Promise<void>;
  /** Deletes whole spreadsheet rows (1-based numbers) of one tab in a single atomic request. */
  deleteRows(tabName: string, rows: number[]): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

interface GoogleLikeError {
  code?: number | string;
  status?: number;
  response?: { status?: number; data?: { error?: { errors?: { reason?: string }[]; status?: string } } };
}

/** Maps any Google/network failure to a SheetsError with a safe public message. */
export function mapGoogleError(err: unknown): SheetsError {
  if (err instanceof SheetsError) return err;
  const e = (err ?? {}) as GoogleLikeError;
  const status = Number(e.response?.status ?? e.status ?? (typeof e.code === "number" ? e.code : NaN));
  const reasons = (e.response?.data?.error?.errors ?? []).map((x) => x.reason ?? "");
  const code = typeof e.code === "string" ? e.code : "";

  if (code === "ETIMEDOUT" || code === "ECONNABORTED" || code === "ESOCKETTIMEDOUT") {
    return new SheetsError("timeout", "The data service timed out. Please try again.", { cause: err });
  }
  if (status === 429 || reasons.some((r) => /rateLimit|quota/i.test(r))) {
    return new SheetsError("rate_limited", "The data service is busy. Please try again shortly.", { cause: err });
  }
  if (status === 401) {
    return new SheetsError("auth_failed", "The data service rejected its credentials.", { cause: err });
  }
  if (status === 403) {
    return new SheetsError("permission_denied", "The spreadsheet is not shared with the service account.", { cause: err });
  }
  if (status === 404) {
    return new SheetsError("spreadsheet_not_found", "The spreadsheet could not be found.", { cause: err });
  }
  if (status === 400) {
    // Typically a missing tab / invalid range.
    return new SheetsError("schema_invalid", "A required spreadsheet tab is missing or misnamed.", { cause: err });
  }
  return new SheetsError("upstream_error", "The data service is temporarily unavailable.", { cause: err });
}

function isRetryable(err: SheetsError): boolean {
  return err.code === "rate_limited" || err.code === "timeout" || err.code === "upstream_error";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs `op`, retrying transient failures with exponential backoff. */
export async function withRetry<T>(op: () => Promise<T>, sleepFn: (ms: number) => Promise<void> = sleep): Promise<T> {
  let last: SheetsError | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await op();
    } catch (err) {
      last = mapGoogleError(err);
      if (!isRetryable(last) || attempt === MAX_ATTEMPTS - 1) throw last;
      await sleepFn(BASE_BACKOFF_MS * 2 ** attempt);
    }
  }
  throw last!;
}

function createGoogleClient(config: SheetsConfig): SheetsClient {
  const jwt = new auth.JWT({
    email: config.clientEmail,
    key: config.privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const api = sheetsApi({ version: "v4", auth: jwt });
  const spreadsheetId = config.spreadsheetId;
  const opts = { timeout: REQUEST_TIMEOUT_MS };
  const sheetIds = new Map<string, number>();

  async function sheetIdOf(tabName: string): Promise<number> {
    const known = sheetIds.get(tabName);
    if (known !== undefined) return known;
    const res = await withRetry(() =>
      api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" }, opts),
    );
    for (const s of res.data.sheets ?? []) {
      if (s.properties?.title != null && s.properties.sheetId != null) sheetIds.set(s.properties.title, s.properties.sheetId);
    }
    const id = sheetIds.get(tabName);
    if (id === undefined) throw new SheetsError("schema_invalid", "A required spreadsheet tab is missing or misnamed.");
    return id;
  }

  return {
    async getValues(range) {
      return withRetry(async () => {
        const res = await api.spreadsheets.values.get({ spreadsheetId, range, majorDimension: "ROWS" }, opts);
        const values = res.data.values;
        if (values === undefined || values === null) return [];
        if (!Array.isArray(values)) throw new SheetsError("malformed_response", "The data service returned an unexpected response.");
        return values.map((row) => (Array.isArray(row) ? row.map((c) => (c == null ? "" : String(c))) : []));
      });
    },
    async appendValues(range, rows) {
      // RAW: values are stored as literal text and never interpreted as formulas.
      // Appends are not retried automatically after an ambiguous failure to avoid duplicate rows.
      try {
        await api.spreadsheets.values.append(
          { spreadsheetId, range, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: rows } },
          opts,
        );
      } catch (err) {
        throw mapGoogleError(err);
      }
    },
    async deleteRows(tabName, rows) {
      if (rows.length === 0) return;
      const sheetId = await sheetIdOf(tabName);
      // Highest row first so earlier deletions never shift the rows still to be deleted.
      const requests = [...new Set(rows)]
        .sort((a, b) => b - a)
        .map((row) => ({ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: row - 1, endIndex: row } } }));
      // Not auto-retried: repeating an ambiguous delete could remove the wrong rows.
      try {
        await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }, opts);
      } catch (err) {
        throw mapGoogleError(err);
      }
    },
    async updateValues(range, rows) {
      await withRetry(async () => {
        await api.spreadsheets.values.update(
          { spreadsheetId, range, valueInputOption: "RAW", requestBody: { values: rows } },
          opts,
        );
      });
    },
  };
}

let override: SheetsClient | null = null;
let cached: { client: SheetsClient } | null = null;

/**
 * True only for the isolated browser E2E suite: SHEETS_TEST_BACKEND=memory outside production.
 * It swaps Google for an in-memory copy of the same four tabs. It is impossible to enable in
 * production (see getSheetsClient).
 */
export function isMemoryBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SHEETS_TEST_BACKEND === "memory" && env.NODE_ENV !== "production";
}

/** Returns the shared client, building it from the environment on first use. */
export function getSheetsClient(): SheetsClient {
  if (override) return override;
  if (process.env.SHEETS_TEST_BACKEND && process.env.NODE_ENV === "production") {
    throw new SheetsError("not_configured", "SHEETS_TEST_BACKEND must never be set in production.");
  }
  if (isMemoryBackend()) return memorySheets();
  if (!cached) cached = { client: createGoogleClient(loadSheetsConfig()) };
  return cached.client;
}

/** Test hook: inject a fake client (or pass null to restore the real one). */
export function setSheetsClientForTesting(client: SheetsClient | null): void {
  override = client;
  cached = null;
  invalidateTableCache();
}
