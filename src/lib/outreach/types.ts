/**
 * Part 2 (Outreach Database -> Connections -> per-member Gmail drafts). Pure types and constants.
 * Google Sheets is the only store: the Outreach Database spreadsheet holds the contacts and the tracking tabs below.
 */
import type { MemberId } from "@/config/members";

export const MASTER_TAB = "Master Contacts";
/** One row per contact that entered the pipeline (imported from the Outreach Database OR added manually). */
export const TRACKING_TAB = "Added in Outreach Emails";
/** One row per local day: derived counters (a convenience copy; the tracking tab is the source of truth). */
export const COUNTERS_TAB = "Outreach Daily Counters";
/** Key/value state of the outreach worker (run lock). */
export const STATE_TAB = "Outreach State";
/** Durable idempotency + history of every send attempt (one active row per recipient e-mail). */
export const SEND_LEDGER_TAB = "Outreach Send Ledger";
/** OPTIONAL. Contacts to import BEFORE the rest of Master Contacts (same columns as Master; see priority.ts). Not created automatically. */
export const PRIORITY_TAB = "Priority Contacts";
/** Hand-maintained opt-outs / exclusions (e-mail or domain). */
export const EXCLUSIONS_TAB = "Outreach Exclusions";

export const DAILY_IMPORT_LIMIT = 200;
/** Contacts imported by one cron call (one at a time); the daily limit is reached over several calls. */
export const DEFAULT_IMPORT_PER_RUN = 10;
export const MAX_IMPORT_ATTEMPTS = 3;

/**
 * The code-level sending switch. It is a compile-time constant, NOT an environment variable, so configuration alone cannot flip it.
 * It is now `true`: the send workflow exists and is tested, but NOTHING runs unless the outreach cron is enabled
 * (OUTREACH_ENABLED=true plus OUTREACH_CRON_SECRET and OUTREACH_SPREADSHEET_ID), and every send still has to pass all 14 validations,
 * the daily limits and (when configured) the recipient allowlist. Setting it back to `false` instantly disables all sending.
 */
export const SENDING_ENABLED = true as const;

/** "existing-draft": a Connection that already had unsent JobSync drafts in the members' Gmail (e.g. Network Finder drafts) and was brought into the send workflow. */
export type ContactSource = "outreach-database" | "manual" | "existing-draft";
/** importing = claimed, Connection not yet confirmed; added = Connection saved; import_failed = gave up after MAX_IMPORT_ATTEMPTS. */
export type ImportStatus = "importing" | "added" | "import_failed";
/** awaiting = no draft yet; drafting = some mailboxes done; drafted = all connected mailboxes; needs_review = a draft carries a review flag; failed; sent = Gmail confirmed. */
export type ProcessingStatus = "awaiting" | "drafting" | "drafted" | "needs_review" | "failed" | "sent";
export type Segment = "person-and-company" | "company-only" | "person-only" | "neither";

/** The Master Contacts columns the importer needs (everything else stays in the Outreach Database, untouched). */
export interface OutreachContact {
  contactId: string;
  personName: string;
  personDesignation: string;
  personEmail: string;
  companyName: string;
  companyUrl: string;
  companyDescription: string;
  primaryRoleCategory: string;
  roleBasis: string;
  roleVerificationStatus: string;
  companyVerificationStatus: string;
  contactKind: string;
  emailKind: string;
  duplicateGroup: string;
  salutationName: string;
  companyReference: string;
  /** 2-based sheet row number in Master Contacts. */
  sheetRow: number;
}

export interface MemberDraftInfo {
  /** NF_Drafts status: created | sent | failed | skipped_unauthorized | deleted | "" (none yet). */
  status: string;
  /** The resume attached (file name), "none" when the draft has no attachment, "" while unknown. */
  resume: string;
}

export interface TrackingRecord {
  /** 1-based sheet row (0 for a record not written yet). */
  row: number;
  contactId: string;
  email: string;
  source: ContactSource;
  importStatus: ImportStatus;
  connectionId: string;
  ownerMemberId: string;
  /** Local date (app timezone) the import was claimed; "" for manual connections. */
  importDay: string;
  claimedAt: string;
  addedAt: string;
  attempts: number;
  segment: Segment;
  targetRole: string;
  roleBasis: string;
  processing: ProcessingStatus;
  drafts: Record<MemberId, MemberDraftInfo>;
  reviewReason: string;
  /** "disabled" while sending is off; "sent" only after Gmail confirmed the send. */
  sendStatus: SendStatus;
  sentAt: string;
  lastError: string;
  updatedAt: string;
  /** Why the last send evaluation did not send (empty when nothing blocks). */
  sendBlockReason: string;
  /** The member whose Gmail sent the e-mail (the Connection owner). */
  sentBy: string;
  /** The Gmail address used (an address, never a token). */
  gmailAccount: string;
  gmailMessageId: string;
  /** The resume file that was attached to the sent message. */
  resumeSent: string;
  sendAttempts: number;
}

/** disabled = sending off; pending = eligible, waiting its turn; blocked = a check failed (see SendBlockReason); review = a person must look; sent = Gmail confirmed. */
export type SendStatus = "disabled" | "pending" | "blocked" | "review" | "claimed" | "sent" | "uncertain" | "failed";

/**
 * "sent_outside": Gmail proved this member's message to this recipient was ALREADY SENT outside JobSync (the draft's message is labelled SENT, or Gmail
 * refused the send as "Message not a draft" and the message is SENT). Nothing was sent by this system, so it is never counted as an automated send; it only
 * stops the recipient being attempted again. Earlier rows are never rewritten into this status.
 */
export type SendLedgerStatus = "claimed" | "sending" | "sent" | "sent_outside" | "uncertain" | "failed_transient" | "failed_permanent" | "needs_review" | "superseded" | "released";

export interface SendRecord {
  row: number;
  sendKey: string;
  contactId: string;
  claimId: string;
  status: SendLedgerStatus;
  member: string;
  gmailAccount: string;
  connectionId: string;
  company: string;
  role: string;
  resumeFile: string;
  resumeSha256: string;
  resumeBytes: number;
  draftId: string;
  threadId: string;
  gmailMessageId: string;
  wordCount: number;
  attempts: number;
  /** ISO time before which a transient failure must not be retried. */
  notBefore: string;
  sentAt: string;
  /** Local (IST) date of the confirmed send. */
  sentDay: string;
  reason: string;
  /** Compact reconciliation / retry history ("<iso> <event>; ..."), capped. */
  history: string;
  createdAt: string;
  updatedAt: string;
}

export interface DailyCounters {
  day: string;
  /** Contacts claimed and successfully added to Connections from the Outreach Database today. */
  importedToday: number;
  /** All contacts in Connections that entered the pipeline (any day, any source). */
  addedToConnections: number;
  /** (contact, mailbox) drafts that exist (created or sent). */
  emailsDrafted: number;
  /** (contact, mailbox) drafts Gmail confirmed as sent. Always 0 while sending is off. */
  emailsSent: number;
  awaitingProcessing: number;
  requiringReview: number;
  /** Contacts whose last drafting attempt failed. */
  failedProcessing: number;
  /** Contacts that could not be added to Connections after repeated attempts. */
  importFailed: number;
  /** Contacts still waiting in the Outreach Database queue (not yet tracked). */
  queueRemaining: number;
  /** Messages Gmail confirmed as sent today (IST), from the send ledger. */
  sentToday: number;
  sentTodayByMember: Record<MemberId, number>;
  /** Send attempts that ended in a permanent failure, plus transient failures still waiting for a retry. */
  failedSends: number;
  /** Contacts whose last send evaluation was blocked (opt-out, limit, missing draft ...). */
  skippedContacts: number;
  /** Distinct duplicate contacts the pipeline stopped (linked to an existing Connection, manual-first, lost claim races). */
  duplicatesPrevented: number;
  /** Sends that need a person: review-flagged drafts and uncertain results. */
  sendsNeedingReview: number;
}

/** The send-related fields of a tracking record that has not been through the send workflow. */
export const emptySendFields = (): Pick<TrackingRecord, "sendStatus" | "sendBlockReason" | "sentBy" | "gmailAccount" | "gmailMessageId" | "resumeSent" | "sendAttempts"> => ({
  sendStatus: "disabled", sendBlockReason: "", sentBy: "", gmailAccount: "", gmailMessageId: "", resumeSent: "", sendAttempts: 0,
});

export const emptyDrafts = (): Record<MemberId, MemberDraftInfo> => ({
  anni: { status: "", resume: "" },
  lukky: { status: "", resume: "" },
  rishii: { status: "", resume: "" },
});
