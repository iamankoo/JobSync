/** Letters to a 1-based column number (A -> 1, AA -> 27). */
function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * Applies an A1 range such as `Tab!A:A`, `Tab!A5:C9`, `Tab!B7:B` or `Tab!1:1` to a tab held as rows of strings.
 * Used by the in-memory Sheets stand-ins (the real API does this itself). Rows are returned from the first
 * requested row; trailing blanks are not trimmed (callers ignore them).
 */
export function sliceA1(tab: string[][], range: string): string[][] {
  const part = range.includes("!") ? range.slice(range.indexOf("!") + 1) : range;
  const rows = /^(\d+):(\d+)$/.exec(part);
  if (rows) return tab.slice(Number(rows[1]) - 1, Number(rows[2])).map((r) => [...r]);
  const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(part);
  if (!m) return tab.map((r) => [...r]);
  const c1 = columnNumber(m[1]);
  const c2 = m[3] ? columnNumber(m[3]) : c1;
  const r1 = m[2] ? Number(m[2]) : 1;
  const r2 = m[4] ? Number(m[4]) : tab.length;
  return tab.slice(r1 - 1, r2).map((r) => Array.from({ length: c2 - c1 + 1 }, (_, i) => r[c1 - 1 + i] ?? ""));
}
