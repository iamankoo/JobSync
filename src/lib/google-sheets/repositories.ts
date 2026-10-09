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
import { readTable } from "./table";

export interface Located<T> {
  row: number;
  value: T;
}

async function readParsed<T>(
  tab: TabKey,
  parse: (cells: string[]) => RowParse<T>,
  keyOf?: (v: T) => string,
): Promise<{ items: Located<T>[]; issues: RowIssue[] }> {
  const rows = await readTable(tab);
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
  return { items, issues };
}

const unwrap = <T>(r: { items: Located<T>[]; issues: RowIssue[] }): ReadResult<T> => ({
  items: r.items.map((i) => i.value),
  issues: r.issues,
});

// ---- Jobs ---------------------------------------------------------------

export async function readJobs(): Promise<ReadResult<Job>> {
  return unwrap(await readParsed("jobs", parseJobRow, (j) => j.jobId));
}

export async function appendJob(job: Job): Promise<void> {
  await getSheetsClient().appendValues(tableRange("jobs"), [serializeJob(job)]);
}

// ---- Applications -------------------------------------------------------

export const applicationKey = (jobId: string, memberId: string) => `${jobId}\u0000${memberId}`;

/** Reads all applications with their row numbers. The first row per (JobID, MemberID) wins. */
export function readApplicationsLocated() {
  return readParsed("applications", parseApplicationRow, (a) => applicationKey(a.jobId, a.memberId));
}

export async function readApplications(): Promise<ReadResult<Application>> {
  return unwrap(await readApplicationsLocated());
}

export async function appendApplication(app: Application): Promise<void> {
  await getSheetsClient().appendValues(tableRange("applications"), [serializeApplication(app)]);
}

/** Overwrites exactly one existing application row (never the whole sheet). */
export async function updateApplicationRow(row: number, app: Application): Promise<void> {
  await getSheetsClient().updateValues(rowRange("applications", row), [serializeApplication(app)]);
}

// ---- Members ------------------------------------------------------------

export async function readMembers(): Promise<ReadResult<MemberRecord>> {
  return unwrap(await readParsed("members", parseMemberRow, (m) => m.memberId));
}

// ---- Activity -----------------------------------------------------------

export async function readActivity(): Promise<ReadResult<Activity>> {
  return unwrap(await readParsed("activity", parseActivityRow, (a) => a.activityId));
}

export async function appendActivity(activity: Activity): Promise<void> {
  await getSheetsClient().appendValues(tableRange("activity"), [serializeActivity(activity)]);
}
