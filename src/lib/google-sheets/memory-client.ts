import "server-only";
import { TABS, optionalHeaders, type TabKey } from "./schema";
import type { SheetsClient } from "./client";
import { sliceA1 } from "./a1";

/**
 * In-memory stand-in for Google Sheets, used ONLY by the isolated browser E2E suite
 * (SHEETS_TEST_BACKEND=memory, never in production). It has the same four tabs and headers as the
 * real spreadsheet, so the real routes, services and validation run unchanged against it.
 */
const MEMBER_ROWS = [
  ["anni", "Anni", "/assets/anni.jpeg", "TRUE"],
  ["lukky", "Lukky", "/assets/lukky.jpeg", "TRUE"],
  ["rishii", "Rishii", "/assets/rishii.jpeg", "TRUE"],
];

export class MemorySheets implements SheetsClient {
  tabs = new Map<string, string[][]>();

  constructor() {
    this.reset();
  }

  /** Clears all data rows; keeps headers; re-seeds the three Members rows. */
  reset(): void {
    for (const key of Object.keys(TABS) as TabKey[]) {
      const t = TABS[key];
      this.tabs.set(t.name, [[...t.headers, ...optionalHeaders(key)]]);
    }
    this.tabs.get("Members")!.push(...MEMBER_ROWS.map((r) => [...r]));
  }

  rows(tab: string): string[][] {
    const t = this.tabs.get(tab);
    if (!t) throw new Error(`Unknown tab ${tab}`);
    return t;
  }

  private tabOf(range: string): string[][] {
    const t = this.tabs.get(range.split("!")[0]);
    if (!t) throw Object.assign(new Error("Unable to parse range"), { code: 400, response: { status: 400 } });
    return t;
  }

  async getValues(range: string): Promise<string[][]> {
    const t = this.tabOf(range);
    if (/!1:1$/.test(range)) return t.slice(0, 1).map((r) => [...r]);
    return sliceA1(t, range);
  }

  async appendValues(range: string, rows: string[][]): Promise<void> {
    this.tabOf(range).push(...rows.map((r) => [...r]));
  }

  async updateValues(range: string, rows: string[][]): Promise<void> {
    const t = this.tabOf(range);
    const m = /![A-Z]+(\d+):[A-Z]+\d+$/.exec(range);
    if (!m) throw new Error(`bad update range ${range}`);
    const start = Number(m[1]);
    rows.forEach((r, i) => {
      // Like Sheets, only the provided cells change; later cells in the row keep their values.
      const existing = t[start - 1 + i] ?? [];
      t[start - 1 + i] = [...r, ...existing.slice(r.length)];
    });
  }

  async deleteRows(tabName: string, rows: number[]): Promise<void> {
    const t = this.tabOf(`${tabName}!A:A`);
    for (const row of [...new Set(rows)].sort((a, b) => b - a)) {
      if (row >= 2 && row <= t.length) t.splice(row - 1, 1);
    }
  }
}

const g = globalThis as unknown as { __jobsyncMemorySheets?: MemorySheets };

/** One shared instance per server process (survives dev-server module reloads). */
export function memorySheets(): MemorySheets {
  return (g.__jobsyncMemorySheets ??= new MemorySheets());
}
