import "server-only";
import { getSheetsClient } from "./client";
import { SheetsError } from "./errors";
import { optionalHeaders, TABS, tableRange, tableWidth, type TabKey } from "./schema";

export interface TableMeta {
  /** True when every optional trailing header of the tab is present (e.g. the follow-up columns). */
  optionalColumns: boolean;
}

export interface RawRow {
  /** 1-based spreadsheet row number (header is row 1). */
  row: number;
  /** Cells padded to the table width. Always strings. */
  cells: string[];
}

export function headerProblems(tab: TabKey, header: string[] | undefined): string[] {
  const expected = TABS[tab].headers;
  if (!header || header.every((c) => c.trim() === "")) {
    return [`Tab "${TABS[tab].name}" has no header row.`];
  }
  const problems: string[] = [];
  expected.forEach((name, i) => {
    const actual = (header[i] ?? "").trim();
    if (actual !== name) {
      problems.push(`Tab "${TABS[tab].name}" column ${i + 1} should be "${name}" but is "${actual || "(empty)"}".`);
    }
  });
  // Optional trailing columns: each must be exactly its name, or empty (feature not enabled yet).
  optionalHeaders(tab).forEach((name, j) => {
    const i = expected.length + j;
    const actual = (header[i] ?? "").trim();
    if (actual !== "" && actual !== name) {
      problems.push(`Tab "${TABS[tab].name}" column ${i + 1} should be "${name}" (or left empty) but is "${actual}".`);
    }
  });
  return problems;
}

/** Whether all optional trailing headers are present (and therefore the feature is enabled). */
export function optionalColumnsPresent(tab: TabKey, header: string[] | undefined): boolean {
  const opt = optionalHeaders(tab);
  if (opt.length === 0) return false;
  const start = TABS[tab].headers.length;
  return opt.every((name, j) => (header?.[start + j] ?? "").trim() === name);
}

/**
 * Short-lived read cache. Many people (and the auto-refresh of every open tab) read the same tabs,
 * and Google allows only ~60 reads/minute per user, so reads within the TTL are shared.
 * Writes on this instance invalidate it, and read-check-write sequences use `fresh: true`.
 * Other instances can be stale for at most the TTL (default 5 s; 0 disables, as under test).
 */
const cache = new Map<TabKey, { at: number; rows: RawRow[]; meta: TableMeta }>();
/**
 * Reads of a tab currently in progress, so simultaneous requests (several tabs auto-refreshing,
 * a layout and its page) share one Google call instead of each spending quota. Tagged with the
 * cache generation: a write on this instance bumps it, so no read that started before the write
 * is ever reused after it.
 */
const inflight = new Map<TabKey, { generation: number; promise: Promise<{ rows: RawRow[]; meta: TableMeta }> }>();
let generation = 0;
let ttlOverride: number | null = null;

function ttlMs(): number {
  if (ttlOverride !== null) return ttlOverride;
  const fromEnv = Number(process.env.SHEETS_CACHE_TTL_MS);
  if (process.env.SHEETS_CACHE_TTL_MS !== undefined && Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return process.env.NODE_ENV === "test" ? 0 : 5000;
}

export function invalidateTableCache(): void {
  generation += 1;
  cache.clear();
  inflight.clear();
}

/** Test hook: set the cache TTL in ms (null restores the default). */
export function setTableCacheTtlForTesting(ms: number | null): void {
  ttlOverride = ms;
  invalidateTableCache();
}

/**
 * Reads a whole tab, verifying its header row first. Blank rows are skipped.
 * Never writes: a wrong header is reported, not repaired.
 */
export async function readTable(tab: TabKey, options: { fresh?: boolean; maxAgeMs?: number } = {}): Promise<RawRow[]> {
  return (await readTableWithMeta(tab, options)).rows;
}

export async function readTableWithMeta(tab: TabKey, options: { fresh?: boolean; maxAgeMs?: number } = {}): Promise<{ rows: RawRow[]; meta: TableMeta }> {
  // `maxAgeMs` can only SHORTEN the shared TTL (chat polling wants fresher data than the dashboards).
  const ttl = options.maxAgeMs === undefined ? ttlMs() : Math.min(ttlMs(), options.maxAgeMs);
  const hit = cache.get(tab);
  if (!options.fresh && ttl > 0 && hit && Date.now() - hit.at < ttl) return { rows: hit.rows, meta: hit.meta };
  // A non-fresh read may join one already under way (it returns data at least as new as a cache
  // hit would). A fresh read (read-check-write) always starts its own.
  const running = inflight.get(tab);
  if (!options.fresh && running && running.generation === generation) return running.promise;

  const startedIn = generation;
  const promise = readTableUncached(tab);
  inflight.set(tab, { generation: startedIn, promise });
  try {
    const result = await promise;
    // Only cache a read that no local write has overtaken.
    if (ttl > 0 && startedIn === generation) cache.set(tab, { at: Date.now(), ...result });
    else if (ttl <= 0) cache.delete(tab);
    return result;
  } finally {
    if (inflight.get(tab)?.promise === promise) inflight.delete(tab);
  }
}

async function readTableUncached(tab: TabKey): Promise<{ rows: RawRow[]; meta: TableMeta }> {
  const values = await getSheetsClient().getValues(tableRange(tab));
  const problems = headerProblems(tab, values[0]);
  if (problems.length) {
    console.error(`[sheets] schema problem: ${problems.join(" ")}`);
    throw new SheetsError("schema_invalid", `The "${TABS[tab].name}" tab does not match the expected header row. See docs/setup.`);
  }
  const width = tableWidth(tab);
  const rows: RawRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const cells = Array.from({ length: width }, (_, c) => (values[i][c] ?? "").toString());
    if (cells.every((c) => c.trim() === "")) continue;
    rows.push({ row: i + 1, cells });
  }
  return { rows, meta: { optionalColumns: optionalColumnsPresent(tab, values[0]) } };
}

/** Returns header problems for a tab without throwing (used by the status check). */
export async function checkTabHeader(tab: TabKey): Promise<string[]> {
  const values = await getSheetsClient().getValues(`${TABS[tab].name}!1:1`);
  return headerProblems(tab, values[0]);
}
