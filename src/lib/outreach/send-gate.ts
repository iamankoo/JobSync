/**
 * Send eligibility and duplicate-send protection: INFRASTRUCTURE ONLY. Nothing here can send an email.
 *
 *  - `evaluateSendEligibility` is the checklist Part 3 will run before an automatic send (recipient, personalisation, resume,
 *    duplicate-send, review flags). Anything failing means "create/keep the draft and flag it for review".
 *  - `attemptSend` only ever talks to a `Mailer` it is given. The only mailers that exist in Part 2 are test mocks. While
 *    `SENDING_ENABLED` is the constant `false`, it refuses before touching the mailer, so no configuration can switch sending on.
 *  - A send is counted only after the mailer confirms it (`confirmedMessageId`), never for a failed or unconfirmed attempt.
 */
import { normalizeEmail } from "@/lib/hr-master/normalize";
import { SENDING_ENABLED, type TrackingRecord } from "./types";
import type { MemberId } from "@/config/members";

export interface DraftFacts {
  member: MemberId;
  /** The recipient on the Gmail draft, read back. */
  to: string;
  body: string;
  /** Attached file names read back from the saved draft. */
  attachments: readonly string[];
  /** Ledger status of this (contact, mailbox) draft. */
  status: string;
  /** Review flags recorded with the draft. */
  reviewFlags: readonly string[];
}

export interface SendCheck {
  eligible: boolean;
  reasons: string[];
}

const PLACEHOLDER = /\{\{|\}\}|\[(name|company|role)\]|undefined|null/i;

/**
 * `expectedResume` = the file the resume rules chose for this member and role ("" when none could be). A send is eligible only if
 * everything lines up exactly; otherwise the draft stays a draft for a human.
 */
export function evaluateSendEligibility(record: Pick<TrackingRecord, "email" | "sendStatus" | "processing" | "importStatus">, facts: DraftFacts, expectedResume: string, alreadySentTo: ReadonlySet<string>): SendCheck {
  const reasons: string[] = [];
  const to = normalizeEmail(facts.to);
  if (!to.valid) reasons.push("recipient is not a valid address");
  else if (to.email !== normalizeEmail(record.email).email) reasons.push("draft recipient differs from the contact's address");
  if (record.importStatus !== "added") reasons.push("contact was not added to Connections");
  if (facts.status !== "created") reasons.push(facts.status === "sent" ? "already sent" : "no live draft");
  if (record.sendStatus === "sent" || alreadySentTo.has(`${facts.member}:${normalizeEmail(record.email).email}`)) reasons.push("already sent to this recipient from this mailbox");
  if (facts.reviewFlags.length) reasons.push(`draft has review flag(s): ${facts.reviewFlags.join(" / ")}`);
  if (PLACEHOLDER.test(facts.body)) reasons.push("draft contains an unresolved placeholder");
  if (!/^Dear [^\n,]+,/.test(facts.body)) reasons.push("draft has no personalised greeting");
  if (!expectedResume) reasons.push("no resume could be chosen for this member and role");
  else if (facts.attachments.length !== 1 || facts.attachments[0] !== expectedResume) reasons.push("attached file is not exactly the chosen resume");
  return { eligible: reasons.length === 0, reasons };
}

export interface Mailer {
  /** Sends the draft; resolves with Gmail's confirmation id, or rejects. */
  sendDraft(member: MemberId, gmailDraftId: string): Promise<{ confirmedMessageId: string }>;
}

export type SendAttempt =
  | { status: "disabled" }
  | { status: "needs_review"; reasons: string[] }
  | { status: "sent"; confirmedMessageId: string }
  | { status: "failed"; error: string };

/**
 * `sendingEnabled` defaults to the compile-time constant. Nothing in the application passes anything else; the parameter exists so
 * unit tests can exercise the guarded path against a MOCK mailer. No real mailer exists in Part 2.
 */
export async function attemptSend(check: SendCheck, mailer: Mailer, member: MemberId, gmailDraftId: string, sendingEnabled: boolean = SENDING_ENABLED): Promise<SendAttempt> {
  if (!sendingEnabled) return { status: "disabled" }; // refuses before the mailer is touched
  if (!check.eligible) return { status: "needs_review", reasons: check.reasons };
  try {
    const { confirmedMessageId } = await mailer.sendDraft(member, gmailDraftId);
    return confirmedMessageId ? { status: "sent", confirmedMessageId } : { status: "failed", error: "no confirmation from Gmail" };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.name : "error" };
  }
}
