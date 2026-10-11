import "server-only";
import { isMemoryBackend } from "./client";
import { loadSheetsConfig } from "./config";
import { SheetsError } from "./errors";
import { readActivity, readApplications, readJobs, readMembers } from "./repositories";
import { TABS, TAB_KEYS, type TabKey } from "./schema";
import { checkTabHeader } from "./table";

export interface TabStatus {
  tab: string;
  ok: boolean;
  /** Valid rows read (only when the header is correct). */
  rows?: number;
  /** Row-level issues found while reading (skipped or partially ignored rows). */
  rowIssues?: number;
  problems: string[];
}

const READERS: Record<TabKey, () => Promise<{ items: unknown[]; issues: unknown[] }>> = {
  jobs: readJobs,
  applications: readApplications,
  members: readMembers,
  activity: readActivity,
};

/**
 * Verifies configuration, connectivity, tab headers and row health. Read-only; returns no
 * credentials or cell contents. Throws SheetsError for config/auth/permission/upstream failures.
 */
export async function checkSheetsStatus(): Promise<{ ok: boolean; tabs: TabStatus[] }> {
  if (!isMemoryBackend()) loadSheetsConfig(); // throws not_configured with variable names only
  const tabs: TabStatus[] = [];
  for (const key of TAB_KEYS) {
    const name = TABS[key].name;
    try {
      const problems = await checkTabHeader(key);
      if (problems.length) {
        tabs.push({ tab: name, ok: false, problems });
        continue;
      }
      const { items, issues } = await READERS[key]();
      tabs.push({ tab: name, ok: true, rows: items.length, rowIssues: issues.length, problems: [] });
    } catch (err) {
      // A missing tab surfaces as schema_invalid; anything else (auth, permission, quota) aborts.
      if (err instanceof SheetsError && err.code === "schema_invalid") {
        tabs.push({ tab: name, ok: false, problems: [err.publicMessage] });
        continue;
      }
      throw err;
    }
  }
  return { ok: tabs.every((t) => t.ok), tabs };
}
