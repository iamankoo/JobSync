import "server-only";
import { getSheetsClient } from "./client";
import { SheetsError } from "./errors";
import { TABS, tableRange, type TabKey } from "./schema";

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
  return problems;
}

/**
 * Reads a whole tab, verifying its header row first. Blank rows are skipped.
 * Never writes: a wrong header is reported, not repaired.
 */
export async function readTable(tab: TabKey): Promise<RawRow[]> {
  const values = await getSheetsClient().getValues(tableRange(tab));
  const problems = headerProblems(tab, values[0]);
  if (problems.length) {
    console.error(`[sheets] schema problem: ${problems.join(" ")}`);
    throw new SheetsError("schema_invalid", `The "${TABS[tab].name}" tab does not match the expected header row. See docs/setup.`);
  }
  const width = TABS[tab].headers.length;
  const rows: RawRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const cells = Array.from({ length: width }, (_, c) => (values[i][c] ?? "").toString());
    if (cells.every((c) => c.trim() === "")) continue;
    rows.push({ row: i + 1, cells });
  }
  return rows;
}

/** Returns header problems for a tab without throwing (used by the status check). */
export async function checkTabHeader(tab: TabKey): Promise<string[]> {
  const values = await getSheetsClient().getValues(`${TABS[tab].name}!1:1`);
  return headerProblems(tab, values[0]);
}
