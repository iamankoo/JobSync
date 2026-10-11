import "server-only";
import type { Activity, Application, Job, MemberRecord, ReadResult, RowIssue } from "@/types/domain";
import { getSheetsClient } from "./client";
import {
  parseActivityRow,
  parseApplicationRow,
  parseJobRow,
  parseMemberRow,
  serializeActivity,
  serializeApplication,
  serializeJob,
  type RowParse,
} from "./rows";
import { rowRange, tableRange, TABS, type TabKey } from "./schema";
import { invalidateTableCache, readTableWithMeta } from "./table";

export interface ReadOptions {
  /** Bypass the short-lived read cache (use inside read-check-write sequences). */
  fresh?: boolean;
}

export interface Located<T> {
  row: number;
  value: T;
}

async function readParsed<T>(
  tab: TabKey,
  parse: (cells: string[]) => RowParse<T>,
  keyOf?: (v: T) => string,
  options: ReadOptions = {},
): Promise<{ items: Located<T>[]; issues: RowIssue[]; optionalColumns: boolean }> {
  const { rows, meta } = await readTableWithMeta(tab, options);
  const items: Located<T>[] = [];
  const issues: RowIssue[] = [];
  const seen = new Set<string>();
  for (const { row, cells } of rows) {
    const parsed = parse(cells);
    if (!parsed.ok) {
      issues.push({ tab: TABS[tab].name, row, problem: `row skipped: ${parsed.problem}` });
      continue;
    }
    for (const w of parsed.warnings) issues.push({ tab: TABS[tab].name, row, problem: w });
    if (keyOf) {
      const key = keyOf(parsed.value);
      if (seen.has(key)) {
        issues.push({ tab: TABS[tab].name, row, problem: "row skipped: duplicate of an earlier row" });
        continue;
      }
      seen.add(key);
    }
    items.push({ row, value: parsed.value });
  }
  if (issues.length) console.warn(`[sheets] ${TABS[tab].name}: ${issues.length} row issue(s) while reading`);
  return { items, issues, optionalColumns: meta.optionalColumns };
}

const unwrap = <T>(r: { items: Located<T>[]; issues: RowIssue[] }): ReadResult<T> => ({
  items: r.items.map((i) => i.value),
  issues: r.issues,
});

// ---- Jobs ---------------------------------------------------------------

export function readJobsLocated(options: ReadOptions = {}) {
  return readParsed("jobs", parseJobRow, (j) => j.jobId, options);
}

export async function readJobs(options: ReadOptions = {}): Promise<ReadResult<Job>> {
  return unwrap(await readJobsLocated(options));
}

export async function appendJob(job: Job): Promise<void> {
  try {
    await getSheetsClient().appendValues(tableRange("jobs"), [serializeJob(job)]);
  } finally {
    invalidateTableCache();
  }
}

/** Overwrites exactly one existing job row (never the whole sheet). */
export async function updateJobRow(row: number, job: Job): Promise<void> {
  try {
    await getSheetsClient().updateValues(rowRange("jobs", row), [serializeJob(job)]);
  } finally {
    invalidateTableCache();
  }
}

/** Deletes whole rows of a tab (1-based row numbers) in one request. */
export async function deleteTabRows(tab: TabKey, rows: number[]): Promise<void> {
  try {
    await getSheetsClient().deleteRows(TABS[tab].name, rows);
  } finally {
    invalidateTableCache();
  }
}

// ---- Applications -------------------------------------------------------

export const applicationKey = (jobId: string, memberId: string) => `${jobId}\u0000${memberId}`;

/** Reads all applications with their row numbers. The first row per (JobID, MemberID) wins. */
export function readApplicationsLocated(options: ReadOptions = {}) {
  return readParsed("applications", parseApplicationRow, (a) => applicationKey(a.jobId, a.memberId), options);
}

export async function readApplications(options: ReadOptions = {}): Promise<ReadResult<Application>> {
  return unwrap(await readApplicationsLocated(options));
}

export async function appendApplication(app: Application, withFollowUp: boolean): Promise<void> {
  try {
    await getSheetsClient().appendValues(tableRange("applications"), [serializeApplication(app, withFollowUp)]);
  } finally {
    invalidateTableCache();
  }
}

/** Overwrites exactly one existing application row (never the whole sheet). */
export async function updateApplicationRow(row: number, app: Application, withFollowUp: boolean): Promise<void> {
  try {
    await getSheetsClient().updateValues(rowRange("applications", row), [serializeApplication(app, withFollowUp)]);
  } finally {
    invalidateTableCache();
  }
}

// ---- Members ------------------------------------------------------------

export async function readMembers(): Promise<ReadResult<MemberRecord>> {
  return unwrap(await readParsed("members", parseMemberRow, (m) => m.memberId));
}

// ---- Activity -----------------------------------------------------------

export function readActivityLocated(options: ReadOptions = {}) {
  return readParsed("activity", parseActivityRow, (a) => a.activityId, options);
}

export async function readActivity(options: ReadOptions = {}): Promise<ReadResult<Activity>> {
  return unwrap(await readActivityLocated(options));
}

/** Overwrites exactly one existing activity row (used only to clear a deleted job's ID). */
export async function updateActivityRow(row: number, activity: Activity): Promise<void> {
  try {
    await getSheetsClient().updateValues(rowRange("activity", row), [serializeActivity(activity)]);
  } finally {
    invalidateTableCache();
  }
}

export async function appendActivity(activity: Activity): Promise<void> {
  try {
    await getSheetsClient().appendValues(tableRange("activity"), [serializeActivity(activity)]);
  } finally {
    invalidateTableCache();
  }
}
