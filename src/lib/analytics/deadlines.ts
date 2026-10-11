import { daysUntil } from "@/lib/jobs/query";

/**
 * Deadline rules (one definition for the Dashboard and Analytics).
 *
 *  - A deadline is a calendar DATE (YYYY-MM-DD). All comparisons use "today" in the configured
 *    application timezone (APP_TIMEZONE), so a job whose deadline is today's date is "due today"
 *    for the whole of that day and "past" from the next day.
 *  - Only jobs the signed-in member has NOT applied to are listed.
 *  - A missing or invalid deadline is never invented: such jobs are counted as "no deadline".
 */
export type DeadlineState = "past" | "today" | "upcoming";

export interface DeadlineInfo {
  state: DeadlineState;
  /** Days from today to the deadline (negative when past). */
  days: number;
  /** Human text, e.g. "Due today", "3 days left", "Passed 2 days ago". */
  remaining: string;
  /** "approaching" = due within 3 days (including today). */
  approaching: boolean;
}

export function classifyDeadline(deadline: string, today: string): DeadlineInfo {
  const days = daysUntil(deadline, today);
  if (days < 0) {
    const ago = -days;
    return { state: "past", days, remaining: `Passed ${ago} day${ago === 1 ? "" : "s"} ago`, approaching: false };
  }
  if (days === 0) return { state: "today", days, remaining: "Due today", approaching: true };
  return { state: "upcoming", days, remaining: `${days} day${days === 1 ? "" : "s"} left`, approaching: days <= 3 };
}

export interface DeadlineItem {
  jobId: string;
  company: string;
  jobRole: string;
  deadline: string;
  info: DeadlineInfo;
}

/** Upcoming (today first, then soonest) followed by the most recent past ones. */
export function orderDeadlines<T extends { deadline: string }>(items: T[], today: string, maxPast = 3): (T & { info: DeadlineInfo })[] {
  const withInfo = items.map((i) => ({ ...i, info: classifyDeadline(i.deadline, today) }));
  const upcoming = withInfo.filter((i) => i.info.state !== "past").sort((a, b) => a.deadline.localeCompare(b.deadline));
  const past = withInfo.filter((i) => i.info.state === "past").sort((a, b) => b.deadline.localeCompare(a.deadline)).slice(0, maxPast);
  return [...upcoming, ...past];
}
