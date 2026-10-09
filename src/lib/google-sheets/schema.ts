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
export const TAB_KEYS = Object.keys(TABS) as TabKey[];

/** 1-based column index to A1 letters (1 -> A, 13 -> M). */
export function columnLetter(n: number): string {
  let s = "";
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/** Range covering the whole table, header included, e.g. `Jobs!A:M`. */
export function tableRange(tab: TabKey): string {
  return `${TABS[tab].name}!A:${columnLetter(TABS[tab].headers.length)}`;
}

/** Range of one data row, e.g. `Applications!A5:G5`. */
export function rowRange(tab: TabKey, row: number): string {
  return `${TABS[tab].name}!A${row}:${columnLetter(TABS[tab].headers.length)}${row}`;
}
