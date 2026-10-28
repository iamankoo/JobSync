import "server-only";
import { auth, sheets as sheetsApi } from "@googleapis/sheets";
import { loadSheetsConfig, type SheetsConfig } from "./config";
import { SheetsError } from "./errors";
import { memorySheets } from "./memory-client";
import { createReadBatcher } from "./read-batcher";
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
/** Timeouts / 5xx / network blips: a couple of quick retries. */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
/**
 * Quota (429) errors: Google's read/write quotas are per MINUTE and shared by every server instance,
 * so sub-second retries just hit the same exhausted window. Back off for seconds (with jitter so
 * instances do not retry in lock-step), as Google recommends, for up to ~15 s in total.
 */
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 8_000;

interface GoogleLikeError {
  code?: number | string;
  status?: number;
  response?: {
    status?: number;
    headers?: Record<string, string | undefined> | { get?: (name: string) => string | null };
    data?: { error?: { errors?: { reason?: string }[]; status?: string } };
  };
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

/**
 * A quota rejection (429 / rateLimitExceeded) is refused by Google BEFORE the request is executed,
 * so even a non-idempotent append or row delete can be repeated safely after one. Timeouts and 5xx
 * are ambiguous (the write may have happened) and are never retried for those operations.
 */
export function isDefinitelyNotApplied(err: SheetsError): boolean {
  return err.code === "rate_limited";
}

/** Server-suggested wait in ms from a Retry-After header (seconds), if Google sent one. */
function retryAfterMs(err: SheetsError): number | undefined {
  const headers = (err.cause as GoogleLikeError | undefined)?.response?.headers;
  if (!headers) return undefined;
  const raw = typeof (headers as { get?: unknown }).get === "function"
    ? (headers as { get: (n: string) => string | null }).get("retry-after")
    : (headers as Record<string, string | undefined>)["retry-after"];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let sleepImpl = realSleep;
const sleep = (ms: number) => sleepImpl(ms);

let retryDeadline: number | null = null;

/**
 * A hard stop for retry sleeping (epoch ms), set by long-running scheduled work. Once a retry's wait would pass it,
 * the error is thrown at once instead of sleeping beyond the function's time limit (28 Oct: five rate-limited
 * retries per call kept every Network Finder run alive until Vercel killed it at 60 s, leaving its lock held).
 * null removes the limit.
 */
export function setSheetsRetryDeadline(deadline: number | null): void {
  retryDeadline = deadline;
}

/** Test hook: replace the backoff sleep (null restores real waiting). */
export function setRetrySleepForTesting(fn: ((ms: number) => Promise<void>) | null): void {
  sleepImpl = fn ?? realSleep;
}

export interface RetryOptions {
  /** Which mapped errors may be retried (default: every transient one). */
  retryOn?: (err: SheetsError) => boolean;
  /** Source of jitter in [0, 1) (injectable for tests). */
  random?: () => number;
}

/** Delay before retry number `attempt` (0-based) after `err`. Exported for tests. */
export function backoffMs(err: SheetsError, attempt: number, random: () => number = Math.random): number {
  const base = err.code === "rate_limited" ? RATE_LIMIT_BASE_BACKOFF_MS : BASE_BACKOFF_MS;
  const jittered = Math.min(base * 2 ** attempt, MAX_BACKOFF_MS) * (0.75 + 0.5 * random());
  const hinted = retryAfterMs(err);
  return Math.round(Math.min(Math.max(jittered, hinted ?? 0), MAX_BACKOFF_MS * 1.25));
}

/** Runs `op`, retrying transient failures with exponential backoff and jitter. */
export async function withRetry<T>(
  op: () => Promise<T>,
  sleepFn: (ms: number) => Promise<void> = sleep,
  { retryOn = isRetryable, random = Math.random }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const mapped = mapGoogleError(err);
      const limit = mapped.code === "rate_limited" ? RATE_LIMIT_MAX_ATTEMPTS : MAX_ATTEMPTS;
      if (!retryOn(mapped) || attempt >= limit - 1) throw mapped;
      const wait = backoffMs(mapped, attempt, random);
      if (retryDeadline !== null && Date.now() + wait > retryDeadline) throw mapped;
      console.warn(`[sheets] ${mapped.code}, retrying (attempt ${attempt + 2} of ${limit})`);
      await sleepFn(wait);
    }
  }
}

/** Converts a Sheets API values grid to strings (missing cells become ""). */
function normaliseValues(values: unknown): string[][] {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new SheetsError("malformed_response", "The data service returned an unexpected response.");
  return values.map((row) => (Array.isArray(row) ? row.map((c) => (c == null ? "" : String(c))) : []));
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

  const readOne = (range: string) =>
    withRetry(async () => {
      const res = await api.spreadsheets.values.get({ spreadsheetId, range, majorDimension: "ROWS" }, opts);
      return normaliseValues(res.data.values);
    });
  const readMany = (ranges: string[]) =>
    withRetry(async () => {
      const res = await api.spreadsheets.values.batchGet({ spreadsheetId, ranges, majorDimension: "ROWS" }, opts);
      const valueRanges = res.data.valueRanges ?? [];
      if (valueRanges.length !== ranges.length) throw new SheetsError("malformed_response", "The data service returned an unexpected response.");
      return valueRanges.map((vr) => normaliseValues(vr.values));
    });
  // Reads issued together (a page's tabs, a layout + its page, a chat poll's two tabs) share one request.
  const batchedRead = createReadBatcher(readMany, readOne);

  return {
    getValues: batchedRead,
    async appendValues(range, rows) {
      // RAW: values are stored as literal text and never interpreted as formulas.
      // Retried ONLY after a quota rejection (never executed); an ambiguous failure (timeout/5xx)
      // is not retried, to avoid duplicate rows.
      await withRetry(
        () =>
          api.spreadsheets.values.append(
            { spreadsheetId, range, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: rows } },
            opts,
          ),
        sleep,
        { retryOn: isDefinitelyNotApplied },
      );
    },
    async deleteRows(tabName, rows) {
      if (rows.length === 0) return;
      const sheetId = await sheetIdOf(tabName);
      // Highest row first so earlier deletions never shift the rows still to be deleted.
      const requests = [...new Set(rows)]
        .sort((a, b) => b - a)
        .map((row) => ({ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: row - 1, endIndex: row } } }));
      // Retried ONLY after a quota rejection (never executed): repeating an ambiguous delete
      // (timeout/5xx) could remove the wrong rows.
      await withRetry(() => api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }, opts), sleep, {
        retryOn: isDefinitelyNotApplied,
      });
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
