/**
 * Tells a member, privately, when their Gmail authorisation has lapsed (or is about to), so drafting and sending for that member do not stall unnoticed.
 *
 * Why this exists: on 8-9 Nov 2026 Lukky's and Rishii's Gmail authorisations ended almost exactly 7 days after they were first used (first use 1 Nov 15:35,
 * last successful send 8 Nov 15:00 / 14:54). That is the signature of Google's 7-day refresh-token limit for an OAuth app that is still in "Testing"
 * status. Nothing told them; 254 contacts then had their drafts skipped until both reconnected at 00:25 / 00:37 on 10 Nov.
 *
 *  - "lapsed":   the member's account is not "connected" (reauth_required / disconnected)  -> one private notification per day until they reconnect.
 *  - "expiring": the account is connected but its authorisation is 6 to 8 days old       -> one private warning per day in that window. Past 8 days the
 *               warning stops by itself: an authorisation that survived 8 days is not subject to the 7-day limit, so it never becomes weekly noise.
 *
 * Exactly-once per member, kind and local day, using the same durable claim as the milestone notifications (an overlapping execution cannot send it twice).
 */
import { randomUUID } from "node:crypto";
import type { MemberId } from "@/config/members";
import { dateInTimezone, nowIso } from "@/lib/utils/time";
import type { PushPayload } from "@/lib/push/payload";
import type { OutreachSheet } from "./sheet";

export const EXPIRY_WARN_FROM_DAYS = 6;
export const EXPIRY_WARN_UNTIL_DAYS = 8;
const DAY_MS = 86_400_000;

export interface AccountHealth {
  memberId: MemberId;
  status: "connected" | "reauth_required" | "disconnected";
  /** When this authorisation was granted (ISO). */
  connectedAt: string;
}

export interface GmailHealthDeps {
  sheet: Pick<OutreachSheet, "claimMilestone" | "completeMilestone" | "releaseMilestone" | "claimedMilestones">;
  accounts(): Promise<readonly AccountHealth[]>;
  /** Private push to one member's devices; "retry" = the devices could not be looked up (the claim is released so a later pass tries again). */
  notifyMember(member: MemberId, payload: PushPayload): Promise<"done" | "retry">;
  now: () => Date;
  timezone: string;
}

export interface GmailHealthResult {
  lapsed: MemberId[];
  expiring: MemberId[];
  alerted: number;
}

export function classify(a: AccountHealth, now: Date): "lapsed" | "expiring" | null {
  if (a.status !== "connected") return "lapsed";
  const age = (now.getTime() - Date.parse(a.connectedAt)) / DAY_MS;
  return Number.isFinite(age) && age >= EXPIRY_WARN_FROM_DAYS && age < EXPIRY_WARN_UNTIL_DAYS ? "expiring" : null;
}

const payloadFor = (kind: "lapsed" | "expiring", member: MemberId, day: string): PushPayload =>
  kind === "lapsed"
    ? { title: "Reconnect your Gmail", body: "JobSync can no longer use your Gmail, so your drafts and e-mails are paused. Open Gmail in JobSync and reconnect.", url: "/gmail", tag: `jobsync-gmail-lapsed:${member}:${day}` }
    : { title: "Your Gmail connection may expire soon", body: "Google can end the connection after about 7 days. Reconnect it in JobSync (Gmail) now to avoid a pause in your e-mails.", url: "/gmail", tag: `jobsync-gmail-expiring:${member}:${day}` };

export async function runGmailHealth(deps: GmailHealthDeps): Promise<GmailHealthResult> {
  const result: GmailHealthResult = { lapsed: [], expiring: [], alerted: 0 };
  const now = deps.now();
  const day = dateInTimezone(now, deps.timezone);
  const claimed = await deps.sheet.claimedMilestones(nowIso(now));
  for (const a of await deps.accounts()) {
    const kind = classify(a, now);
    if (!kind) continue;
    (kind === "lapsed" ? result.lapsed : result.expiring).push(a.memberId);
    const key = `gmail-${kind}:${a.memberId}:${day}`;
    if (claimed.has(key)) continue; // already told today (or another execution is telling them)
    const claimId = randomUUID();
    if (!(await deps.sheet.claimMilestone(key, claimId, nowIso(now)))) continue;
    const verdict = await deps.notifyMember(a.memberId, payloadFor(kind, a.memberId, day)).catch((): "retry" => "retry");
    if (verdict === "retry") {
      await deps.sheet.releaseMilestone(key, claimId, nowIso(now));
      continue;
    }
    await deps.sheet.completeMilestone(key, claimId, nowIso(now));
    result.alerted += 1;
  }
  return result;
}
