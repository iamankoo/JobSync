import { onSheetsClientReset } from "@/lib/google-sheets/client";

/**
 * A short-lived memory of each member's Gmail access (their account row from the NF_GmailAccounts tab and the access token refreshed from it).
 *
 * Why: every Gmail call used to read the whole accounts tab from Google Sheets fresh and refresh an OAuth token first. One send step for 12 e-mails
 * made 27 reads of that tab and 24 token refreshes; against Google's ~60 reads/minute per user that alone could exhaust the quota. Access tokens
 * live for an hour, so reusing one for 90 seconds (about one cron call) is safe.
 *
 * Safety: only SUCCESSFUL lookups are remembered; any change to an account (connect, disconnect, status change) forgets it at once; so does
 * replacing the Sheets client (tests). A token that Google refuses is handled exactly as before (the caller flags the account), because the
 * entry is dropped whenever the account's status is written.
 */
export const ACCESS_TTL_MS = 90_000;
const entries = new Map<string, { at: number; value: unknown }>();

export function cachedAccess<T>(memberId: string, now: number = Date.now()): T | undefined {
  const e = entries.get(memberId);
  if (!e) return undefined;
  if (now - e.at >= ACCESS_TTL_MS) {
    entries.delete(memberId);
    return undefined;
  }
  return e.value as T;
}

export function rememberAccess(memberId: string, value: unknown, now: number = Date.now()): void {
  entries.set(memberId, { at: now, value });
}

/** Forgets one member's access (or everyone's). */
export function forgetAccess(memberId?: string): void {
  if (memberId) entries.delete(memberId);
  else entries.clear();
}

onSheetsClientReset(() => forgetAccess());
