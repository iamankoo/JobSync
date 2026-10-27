import "server-only";
import { isMemoryBackend } from "./client";
import { loadSheetsConfig } from "./config";
import { SheetsError } from "./errors";
import {
  readActivity, readApplications, readCallSignalsLocated, readChatMessagesLocated, readChatReadsLocated, readConnectionsLocated, readJobs, readMembers,
  readNotificationLogLocated, readPushSubscriptionsLocated,
} from "./repositories";
import { isOptionalTab, TABS, TAB_KEYS, type TabKey } from "./schema";
import { checkTabHeader, readTable } from "./table";

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
  pushSubscriptions: readPushSubscriptionsLocated,
  notificationLog: readNotificationLogLocated,
  connections: readConnectionsLocated,
  chatMessages: readChatMessagesLocated,
  // Attachment bytes are never bulk-read: only the header is verified.
  chatFiles: async () => ({ items: [], issues: [] }),
  chatReads: readChatReadsLocated,
  callSignals: readCallSignalsLocated,
  // Profile upload metadata: counted only.
  memberFiles: async () => ({ items: await readTable("memberFiles"), issues: [] }),
  // Network Finder state: counted only (token cells are never returned).
  nfGmailAccounts: async () => ({ items: await readTable("nfGmailAccounts"), issues: [] }),
  nfDrafts: async () => ({ items: await readTable("nfDrafts"), issues: [] }),
  nfCompanies: async () => ({ items: await readTable("nfCompanies"), issues: [] }),
  nfQueue: async () => ({ items: await readTable("nfQueue"), issues: [] }),
  nfState: async () => ({ items: await readTable("nfState"), issues: [] }),
  nfSelections: async () => ({ items: await readTable("nfSelections"), issues: [] }),
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
  // An optional tab (push notifications) that is not set up yet is reported but does not fail the check.
  const optional = new Set<string>(TAB_KEYS.filter(isOptionalTab).map((k) => TABS[k].name));
  return { ok: tabs.every((t) => t.ok || optional.has(t.tab)), tabs };
}
