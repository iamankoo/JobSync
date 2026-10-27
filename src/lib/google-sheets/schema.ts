import "server-only";

export const TABS = {
  jobs: {
    name: "Jobs",
    headers: [
      "JobID", "Company", "JobRole", "JobType", "WorkMode", "Experience", "StipendSalary",
      "Location", "JobURL", "Deadline", "Description", "AddedBy", "AddedAt",
    ],
  },
  applications: {
    name: "Applications",
    headers: ["JobID", "MemberID", "Status", "AppliedAt", "ApplicationStage", "Notes", "LastUpdated"],
    // Optional trailing columns for the 7-day status follow-up. A sheet without them keeps
    // working (follow-ups are simply off) so adding them is a safe, non-destructive step.
    optionalHeaders: ["FollowUpAnswer", "FollowUpAnsweredAt"],
  },
  members: {
    name: "Members",
    headers: ["MemberID", "Name", "Photo", "Active"],
    // Optional trailing columns (E–J): each member's own Profile page details. Entered by the member only;
    // a sheet without these headers keeps working and the values are still stored there. "Name" (B) stays
    // the app's identity mirror, so the member's own name is kept separately in ProfileName.
    // K: the Profile Lock password as a salted scrypt hash (never plaintext). L: failed recovery attempts ("count|since").
    optionalHeaders: ["ProfileName", "LinkedIn", "GitHub", "Email", "Mobile", "ProfileUpdatedAt", "ProfilePasswordHash", "ProfileRecoveryAttempts"],
  },
  activity: {
    name: "Activity",
    headers: ["ActivityID", "MemberID", "Date", "Action", "JobID", "Timestamp"],
  },
  // Browser Web Push subscriptions (one row per member device). Optional: when the tab is absent the
  // app works exactly as before and push notifications are simply unavailable.
  pushSubscriptions: {
    name: "PushSubscriptions",
    headers: ["SubscriptionID", "MemberID", "Endpoint", "P256dh", "Auth", "CreatedAt", "LastSeenAt"],
    optional: true,
  },
  // Ledger of scheduled (10 AM / 10 PM) notifications, so a repeated cron run never notifies twice.
  // Optional: without it the scheduled notifications are refused rather than risking duplicates.
  notificationLog: {
    name: "NotificationLog",
    headers: ["LogKey", "ClaimID", "MemberID", "Type", "LocalDate", "Status", "ClaimedAt", "UpdatedAt", "Detail"],
    optional: true,
  },
  // Connections tracker: people a member wants to reach out to (private to that member). Optional tab.
  connections: {
    name: "Connections",
    headers: ["ConnectionID", "MemberID", "Name", "Company", "Role", "ProfileUrl", "OtherUrl", "Message", "Notes", "Status", "CreatedAt", "UpdatedAt"],
    // Optional trailing column (column M): a sheet without the header keeps working; emails are still stored there.
    optionalHeaders: ["Email"],
    optional: true,
  },
  // Group chat (all three members). Optional tabs: without them the chat page says it is not set up.
  chatMessages: {
    name: "ChatMessages",
    headers: ["MessageID", "MemberID", "Kind", "Text", "FileID", "FileName", "MimeType", "SizeBytes", "DurationSec", "CreatedAt"],
    optional: true,
  },
  // Attachment bytes as base64 chunks (one row per chunk). Only ever read through the authorised download route.
  chatFiles: {
    name: "ChatFiles",
    headers: ["FileID", "Seq", "Data"],
    optional: true,
  },
  // Per-member read marker (the last message row they have seen) for the unread indicator.
  chatReads: {
    name: "ChatReads",
    headers: ["MemberID", "LastReadRow", "UpdatedAt"],
    optional: true,
  },
  // Short-lived WebRTC signalling for audio/video calls (offers, answers, presence). Pruned automatically.
  callSignals: {
    name: "CallSignals",
    headers: ["SignalID", "CallID", "FromMemberID", "ToMemberID", "Type", "Payload", "CreatedAt"],
    optional: true,
  },
  // Profile uploads: each member's resumes (up to 10) and professional photo (one). Metadata only; the bytes are
  // base64 chunks in ChatFiles under FileID (the app's one file store). Optional: without it uploads are off.
  memberFiles: {
    name: "MemberFiles",
    headers: ["RecordID", "MemberID", "Kind", "FileID", "FileName", "MimeType", "SizeBytes", "UploadedAt"],
    optional: true,
  },
  // ---- Network Finder (Phase 2). Optional: until these tabs exist the feature is simply off. ----
  // One row per member who connected Gmail for drafts. The refresh token is AES-256-GCM encrypted (bound to the
  // member) with GMAIL_TOKEN_ENCRYPTION_KEY, so the sheet alone cannot be used to reach anyone's mailbox.
  nfGmailAccounts: {
    name: "NF_GmailAccounts",
    headers: ["MemberID", "GmailAddress", "RefreshTokenEnc", "Scope", "Status", "ConnectedAt", "UpdatedAt", "LastError"],
    optional: true,
  },
  // One row per (item, member) draft, so retries never create a second draft in the same mailbox.
  // Status: created → sent | deleted (checked on later runs), or skipped_unauthorized / failed.
  nfDrafts: {
    name: "NF_Drafts",
    headers: ["DraftKey", "MemberID", "ItemType", "ItemID", "GmailDraftID", "Status", "CreatedAt", "Detail", "ThreadID", "CheckedAt"],
    optional: true,
  },
  // Every company the Network Finder picked (never processed as "new" twice; re-checked later for openings).
  nfCompanies: {
    name: "NF_Companies",
    headers: ["CompanyKey", "Name", "Domain", "Website", "Source", "SourceID", "SourceURL", "Country", "SizeTier", "EmployeeCount", "Remote", "Reasons", "Status", "FirstSeenAt", "LastProcessedAt", "LastJobCheckAt", "ContactsSaved", "JobsSaved", "CareersURL"],
    optional: true,
  },
  // Durable work queue (one row per company task), so a crashed or timed-out run resumes where it stopped.
  nfQueue: {
    name: "NF_Queue",
    headers: ["ItemID", "Status", "Attempts", "NotBefore", "LastError", "Payload", "UpdatedAt"],
    optional: true,
  },
  // Counters, paging cursors, pause state and Apollo usage (key → value). Never holds credentials.
  nfState: {
    name: "NF_State",
    headers: ["Key", "Value", "UpdatedAt"],
    optional: true,
  },
  // The day's selected contact per company and who it is assigned to (17/17/16), plus which mailboxes have its draft.
  nfSelections: {
    name: "NF_Selections",
    headers: ["CompanyKey", "Date", "ConnectionID", "AssignedTo", "ContactName", "Email", "EmailStatus", "CreatedAt", "DraftedFor"],
    optional: true,
  },
} as const;

export type TabKey = keyof typeof TABS;

/** Tabs the app can run without (their feature is simply off while the tab is missing). */
export function isOptionalTab(tab: TabKey): boolean {
  return (TABS[tab] as { optional?: boolean }).optional === true;
}

/** Optional trailing headers of a tab (empty for tabs that have none). */
export function optionalHeaders(tab: TabKey): readonly string[] {
  const t = TABS[tab] as { optionalHeaders?: readonly string[] };
  return t.optionalHeaders ?? [];
}

/** Total columns a tab can use: required + optional. */
export function tableWidth(tab: TabKey): number {
  return TABS[tab].headers.length + optionalHeaders(tab).length;
}
export const TAB_KEYS = Object.keys(TABS) as TabKey[];

/** 1-based column index to A1 letters (1 -> A, 13 -> M). */
export function columnLetter(n: number): string {
  let s = "";
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/** Range covering the whole table, header included, e.g. `Jobs!A:M`. */
export function tableRange(tab: TabKey): string {
  return `${TABS[tab].name}!A:${columnLetter(tableWidth(tab))}`;
}

/** Range of one data row, e.g. `Applications!A5:G5`. */
export function rowRange(tab: TabKey, row: number): string {
  return `${TABS[tab].name}!A${row}:${columnLetter(tableWidth(tab))}${row}`;
}
