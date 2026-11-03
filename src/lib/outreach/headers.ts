/** Header rows of the three outreach tabs. No imports, so the one-time setup script can load it directly. */
export const TRACKING_HEADERS = [
  "ContactID", "Email", "Source", "ImportStatus", "ConnectionID", "OwnerMemberID", "ImportDay", "ClaimedAt", "AddedAt", "Attempts",
  "Segment", "TargetRole", "RoleBasis", "ProcessingStatus",
  "DraftAnni", "DraftLukky", "DraftRishii", "ResumeAnni", "ResumeLukky", "ResumeRishii",
  "ReviewReason", "SendStatus", "SentAt", "LastError", "UpdatedAt",
  "SendBlockReason", "SentBy", "GmailAccount", "GmailMessageId", "ResumeSent", "SendAttempts",
] as const;

export const COUNTER_HEADERS = [
  "Day", "ImportedToday", "AddedToConnections", "EmailsDrafted", "EmailsSent", "AwaitingProcessing", "RequiringReview", "FailedProcessing", "ImportFailed", "QueueRemaining", "UpdatedAt",
  "SentToday", "SentAnni", "SentLukky", "SentRishii", "FailedSends", "SkippedContacts", "DuplicatesPrevented", "SendsNeedingReview",
] as const;

export const STATE_HEADERS = ["Key", "Value", "UpdatedAt"] as const;

/** One row per send attempt for a recipient: the durable idempotency record. SendKey is the normalised recipient e-mail. */
export const SEND_LEDGER_HEADERS = [
  "SendKey", "ContactID", "ClaimID", "Status", "Member", "GmailAccount", "ConnectionID", "Company", "Role", "ResumeFile", "ResumeSha256", "ResumeBytes",
  "DraftID", "ThreadID", "GmailMessageID", "WordCount", "Attempts", "NotBefore", "SentAt", "SentDay", "Reason", "History", "CreatedAt", "UpdatedAt",
] as const;

/** Opt-outs and exclusions, maintained by hand: Value is a full e-mail address or a domain (optionally written @domain). */
export const EXCLUSION_HEADERS = ["Value", "Reason", "AddedAt", "AddedBy"] as const;
