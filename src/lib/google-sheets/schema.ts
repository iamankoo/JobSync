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
} as const;

export type TabKey = keyof typeof TABS;

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
