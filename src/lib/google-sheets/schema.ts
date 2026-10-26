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
