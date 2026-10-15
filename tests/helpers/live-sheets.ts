import { createRequire } from "node:module";
import path from "node:path";
import { loadLiveEnv, requireSafeTestEnv } from "./live-env";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..", "..");
const { auth, sheets } = require(path.join(ROOT, "node_modules/@googleapis/sheets"));

const TAB_NAMES = ["Jobs", "Applications", "Members", "Activity", "PushSubscriptions", "NotificationLog", "Connections", "ChatMessages", "ChatFiles", "ChatReads", "CallSignals"] as const;
const WIDTH: Record<(typeof TAB_NAMES)[number], string> = { Jobs: "M", Applications: "I", Members: "D", Activity: "F", PushSubscriptions: "G", NotificationLog: "I", Connections: "L", ChatMessages: "J", ChatFiles: "C", ChatReads: "C", CallSignals: "G" };

const MEMBER_ROWS = [
  ["anni", "Anni", "/assets/anni.jpeg", "TRUE"],
  ["lukky", "Lukky", "/assets/lukky.jpeg", "TRUE"],
  ["rishii", "Rishii", "/assets/rishii.jpeg", "TRUE"],
];

function client(email: string, privateKey: string) {
  const key = privateKey.replace(/\\n/g, "\n");
  const jwt = new auth.JWT({ email, key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  return sheets({ version: "v4", auth: jwt });
}

/**
 * Direct (independent of the app code) access to the TEST spreadsheet, used to verify what the
 * app actually persisted and to reset the sheet between runs. Every write helper is bound to the
 * test spreadsheet ID and re-checks it is not the production one.
 */
export function openTestSheet() {
  const { email, privateKey, testId, prodId } = requireSafeTestEnv();
  if (testId === prodId) throw new Error("REFUSING: test spreadsheet equals production");
  const api = client(email, privateKey);

  return {
    id: testId,
    /** All rows of a tab including the header (row 1). */
    async readTab(tab: (typeof TAB_NAMES)[number]): Promise<string[][]> {
      const res = await api.spreadsheets.values.get({ spreadsheetId: testId, range: `${tab}!A:${WIDTH[tab]}` });
      return (res.data.values ?? []).map((r: unknown[]) => r.map((c) => String(c)));
    },
    /** Data rows only (header removed). */
    async dataRows(tab: (typeof TAB_NAMES)[number]): Promise<string[][]> {
      return (await this.readTab(tab)).slice(1).filter((r) => r.some((c) => c.trim() !== ""));
    },
    /** Appends a raw row, as if someone typed it into the spreadsheet by hand. */
    async appendRaw(tab: (typeof TAB_NAMES)[number], row: string[]) {
      await api.spreadsheets.values.append({
        spreadsheetId: testId, range: `${tab}!A:${WIDTH[tab]}`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: [row] },
      });
    },
    /** Clears every data row of all tabs and re-seeds the three Members rows. TEST SHEET ONLY. */
    async reset() {
      for (const tab of TAB_NAMES) await api.spreadsheets.values.clear({ spreadsheetId: testId, range: `${tab}!A2:Z` });
      await api.spreadsheets.values.update({ spreadsheetId: testId, range: "Members!A2", valueInputOption: "RAW", requestBody: { values: MEMBER_ROWS } });
    },
    async setMemberActive(memberId: "anni" | "lukky" | "rishii", active: boolean) {
      const row = MEMBER_ROWS.findIndex((r) => r[0] === memberId) + 2;
      await api.spreadsheets.values.update({ spreadsheetId: testId, range: `Members!D${row}`, valueInputOption: "RAW", requestBody: { values: [[active ? "TRUE" : "FALSE"]] } });
    },
    async title(): Promise<string> {
      const res = await api.spreadsheets.get({ spreadsheetId: testId, fields: "properties.title" });
      return res.data.properties?.title ?? "";
    },
  };
}

/**
 * READ-ONLY snapshot of the PRODUCTION spreadsheet (row counts + a content hash per tab), used to
 * prove the live tests never changed it. Performs only `values.get` calls; never writes.
 */
export async function snapshotProduction(): Promise<Record<string, { rows: number; hash: string }> | null> {
  const env = loadLiveEnv();
  if (!env.email || !env.privateKey || !env.prodId) return null;
  const api = client(env.email, env.privateKey);
  const { createHash } = await import("node:crypto");
  const out: Record<string, { rows: number; hash: string }> = {};
  // Only the four original tabs: the optional push tabs may not exist in production yet.
  for (const tab of ["Jobs", "Applications", "Members", "Activity"] as const) {
    const res = await api.spreadsheets.values.get({ spreadsheetId: env.prodId, range: `${tab}!A:${WIDTH[tab]}` });
    const values = (res.data.values ?? []) as unknown[][];
    out[tab] = { rows: values.length, hash: createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16) };
  }
  return out;
}
