import { TABS, type TabKey } from "@/lib/google-sheets/schema";
import { mapGoogleError, type SheetsClient } from "@/lib/google-sheets/client";

/** In-memory stand-in for the Google Sheets API. Stores each tab as rows of strings (header = row 1). */
export class FakeSheets implements SheetsClient {
  tabs = new Map<string, string[][]>();
  calls: { op: "get" | "append" | "update"; range: string }[] = [];
  /** When set, the next matching operation rejects with this error (then clears). */
  failNext: { op?: "get" | "append" | "update"; error: unknown } | null = null;
  /** When set, every operation rejects. */
  failAll: unknown = null;
  /** Yield to the event loop inside operations so concurrent callers interleave. */
  interleave = true;

  constructor(seed: boolean = true) {
    if (seed) this.seedHeaders();
  }

  seedHeaders(): this {
    for (const key of Object.keys(TABS) as TabKey[]) this.tabs.set(TABS[key].name, [[...TABS[key].headers]]);
    return this;
  }

  /** Adds the three members as active rows in the Members tab. */
  seedMembers(active: Partial<Record<"anni" | "lukky" | "rishii", boolean>> = {}): this {
    const rows = this.rows("Members");
    for (const [id, name] of [["anni", "Anni"], ["lukky", "Lukky"], ["rishii", "Rishii"]] as const) {
      rows.push([id, name, `/assets/${id}.jpeg`, (active[id] ?? true) ? "TRUE" : "FALSE"]);
    }
    return this;
  }

  rows(tab: string): string[][] {
    const t = this.tabs.get(tab);
    if (!t) throw new Error(`no tab ${tab}`);
    return t;
  }

  dataRows(tab: string): string[][] {
    return this.rows(tab).slice(1);
  }

  private async gate(op: "get" | "append" | "update", range: string) {
    this.calls.push({ op, range });
    if (this.interleave) await new Promise((r) => setTimeout(r, 0));
    // The real client maps Google errors before they leave it; mirror that here.
    if (this.failAll) throw mapGoogleError(this.failAll);
    if (this.failNext && (!this.failNext.op || this.failNext.op === op)) {
      const { error } = this.failNext;
      this.failNext = null;
      throw mapGoogleError(error);
    }
  }

  private tabOf(range: string): string[][] {
    const name = range.split("!")[0];
    const t = this.tabs.get(name);
    if (!t) throw mapGoogleError(Object.assign(new Error("Unable to parse range"), { code: 400, response: { status: 400 } }));
    return t;
  }

  async getValues(range: string): Promise<string[][]> {
    await this.gate("get", range);
    const t = this.tabOf(range);
    // Sheets omits trailing empty rows/cells; mimic by returning copies.
    if (/!1:1$/.test(range)) return t.slice(0, 1).map((r) => [...r]);
    return t.map((r) => [...r]);
  }

  async appendValues(range: string, rows: string[][]): Promise<void> {
    await this.gate("append", range);
    this.tabOf(range).push(...rows.map((r) => [...r]));
  }

  async updateValues(range: string, rows: string[][]): Promise<void> {
    await this.gate("update", range);
    const t = this.tabOf(range);
    const m = /![A-Z]+(\d+):[A-Z]+\d+$/.exec(range);
    if (!m) throw new Error(`bad update range ${range}`);
    const start = Number(m[1]);
    rows.forEach((r, i) => {
      t[start - 1 + i] = [...r];
    });
  }
}

export function googleError(status: number, reason?: string) {
  return Object.assign(new Error(`google ${status} SECRET-DETAIL-should-not-leak`), {
    code: status,
    response: { status, data: { error: { errors: reason ? [{ reason }] : [] } } },
  });
}
