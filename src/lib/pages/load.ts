import "server-only";
import { redirect } from "next/navigation";
import type { MemberId } from "@/config/members";
import { getSession } from "@/lib/auth/session";
import { SheetsError } from "@/lib/google-sheets/errors";
import { isMemberActive } from "@/lib/google-sheets/members-service";
import { appTimezone } from "@/lib/google-sheets/config";
import { dateInTimezone } from "@/lib/utils/time";

export type LoadResult<T> =
  | { ok: true; data: T }
  | { ok: false; title: string; message: string };

export interface PageContext<T> {
  memberId: MemberId;
  /** Display timezone and today's date in it, so server and client render dates identically. */
  timeZone: string;
  today: string;
  result: LoadResult<T>;
}

/**
 * Loads data for a server-rendered page on behalf of the SESSION member (never a client value).
 * Redirects to /login without a valid session. Data-layer failures become a safe, user-facing
 * error result; no sample data is ever substituted.
 */
export async function loadForMember<T>(load: (memberId: MemberId) => Promise<T>): Promise<PageContext<T>> {
  const session = await getSession();
  if (!session) redirect("/login");
  const { memberId } = session;
  const timeZone = appTimezone();
  const today = dateInTimezone(new Date(), timeZone);

  try {
    if (!(await isMemberActive(memberId))) {
      return { memberId, timeZone, today, result: { ok: false, title: "Account not active", message: "This member is not marked Active in the Members tab of the spreadsheet." } };
    }
    return { memberId, timeZone, today, result: { ok: true, data: await load(memberId) } };
  } catch (err) {
    if (err instanceof SheetsError) {
      console.error(`[page] data service error: ${err.code}`);
      return { memberId, timeZone, today, result: { ok: false, title: "Can't reach the job database", message: err.publicMessage } };
    }
    console.error("[page] unexpected error", err instanceof Error ? err.name : typeof err);
    return { memberId, timeZone, today, result: { ok: false, title: "Something went wrong", message: "Please try again in a moment." } };
  }
}
