export const DEFAULT_TIMEZONE = "Asia/Kolkata";

/** Current instant as an ISO 8601 UTC string, e.g. 2026-10-12T08:30:00.000Z. All stored timestamps use this. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function resolveTimezone(raw: string | undefined): string {
  if (!raw) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: raw });
    return raw;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Calendar date (YYYY-MM-DD) of an instant in the given IANA timezone. Used for Activity.Date. */
export function dateInTimezone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
