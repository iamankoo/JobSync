/** Date-key helpers. A "date key" is a calendar date written YYYY-MM-DD. Pure; safe on client and server. */

function utc(key: string): number {
  return Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10));
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(key: string, days: number): string {
  return fromUtc(utc(key) + days * 86_400_000);
}

export function diffDays(later: string, earlier: string): number {
  return Math.round((utc(later) - utc(earlier)) / 86_400_000);
}

/** The n date keys ending at `end` (inclusive), oldest first. */
export function lastNDays(end: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(end, i - (n - 1)));
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(key: string): number {
  return (new Date(utc(key)).getUTCDay() + 6) % 7;
}

/** The Monday of the week containing `key`. */
export function weekStart(key: string): string {
  return addDays(key, -weekdayIndex(key));
}

export function monthStart(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthLabel(key: string): string {
  return MONTHS[+key.slice(5, 7) - 1];
}

/** "9 Oct" */
export function shortLabel(key: string): string {
  return `${+key.slice(8, 10)} ${monthLabel(key)}`;
}

export function inRange(key: string, start: string, end: string): boolean {
  return key >= start && key <= end;
}

/** First and last day of the calendar quarter containing `key` (Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec). */
export function quarterRange(key: string): { start: string; end: string; months: string[]; label: string } {
  const year = +key.slice(0, 4);
  const first = Math.floor((+key.slice(5, 7) - 1) / 3) * 3; // 0-based month index of the quarter's first month
  const start = `${year}-${String(first + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, first + 3, 0)).getUTCDate(); // day 0 of the next month = last day of the quarter's last month
  const end = `${year}-${String(first + 3).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const months = [first, first + 1, first + 2].map((i) => MONTHS[i]);
  return { start, end, months, label: `${months[0]}–${months[2]} ${year}` };
}
