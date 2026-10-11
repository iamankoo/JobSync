import type { ActivityAction } from "@/types/domain";
import { addDays, diffDays, monthLabel, quarterRange, weekStart } from "./dates";

/**
 * Activity model. Every Activity row is one persisted event for ONE member.
 *
 *  - Meaningful actions (productive work): job_added, job_applied, job_unapplied, application_updated,
 *    follow_up_answered, job_updated, job_deleted.
 *  - Presence events (NOT work): login (a successful sign-in) and visit (a server-validated page
 *    visit, recorded at most once per member per 30 minutes). A visit never counts as a job added,
 *    an application, or any other action, and no "time spent" is measured or claimed.
 *
 * Heatmap intensity and every "actions" total use meaningful actions only.
 */
export const MEANINGFUL_ACTIONS: readonly ActivityAction[] = [
  "job_added", "job_applied", "job_unapplied", "application_updated", "follow_up_answered", "job_updated", "job_deleted",
];
export const PRESENCE_ACTIONS: readonly ActivityAction[] = ["login", "visit"];

export const isMeaningful = (a: ActivityAction) => MEANINGFUL_ACTIONS.includes(a);
export const isPresence = (a: ActivityAction) => PRESENCE_ACTIONS.includes(a);

/** One persisted event of the signed-in member. `date` is the calendar day in the app timezone. */
export interface ActivityEvent {
  date: string;
  action: ActivityAction;
  /** The job the event refers to, when it still exists. Used only to recognise duplicate events. */
  jobId?: string;
  /** ISO 8601 UTC, server-generated. */
  timestamp: string;
}

export interface HeatCell {
  date: string;
  /** Meaningful actions on that day. */
  count: number;
  /** Presence events (logins + visits) on that day. */
  visits: number;
  /** 0 = none, 1 = 1-2, 2 = 3-5, 3 = 6-8, 4 = 9+ meaningful actions. */
  level: 0 | 1 | 2 | 3 | 4;
  /** A day later in the quarter that has not happened yet (shown faint, with no activity). */
  future?: boolean;
  /** Long date for the tooltip, e.g. "Oct 11, 2026". */
  dateLabel: string;
  /** Jobs this member ADDED to the shared Jobs sheet on this day (AddedBy + server AddedAt, app timezone). */
  added: number;
  /** Distinct jobs the member marked Applied on this day (server AppliedAt, app timezone). */
  submitted: number;
  /** Consecutive days of work ending on this day (0 when this day has no work); never uses later days. */
  streak: number;
  /** Text alternative / tooltip: date, count and a short summary. */
  label: string;
}

export interface ActivitySummary {
  /** Days of the current quarter up to and including today. */
  periodDays: number;
  /** Days with at least one meaningful action. */
  activeDays: number;
  totalActions: number;
  jobsAdded: number;
  applied: number;
  /** Not-applied marks, stage/status updates and follow-up answers. */
  applicationUpdates: number;
  /** Logins + visits in the period (presence, not work). */
  visits: number;
  /** Days that had at least one login/visit event. */
  daysVisited: number;
  activeDaysLast7: number;
  activeDaysLast30: number;
  /** Timestamp of the most recent event of any kind, or null when there is none. */
  lastSeen: string | null;
}

export interface ActivityTimeline {
  /** The calendar quarter shown, e.g. { label: "Oct–Dec 2026" }. It rolls over to the next quarter (and year) on its own. */
  period: { start: string; end: string; label: string };
  /** Columns are weeks (Mon..Sun). Days outside the quarter are null; days after today are `future` cells. */
  weeks: (HeatCell | null)[][];
  monthLabels: { column: number; label: string }[];
  summary: ActivitySummary;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const PHRASES: Partial<Record<ActivityAction, (n: number) => string>> = {
  job_added: (n) => plural(n, "job added", "jobs added"),
  job_applied: (n) => `${plural(n, "job")} marked applied`,
  job_unapplied: (n) => `${plural(n, "job")} marked not applied`,
  application_updated: (n) => plural(n, "application update"),
  follow_up_answered: (n) => plural(n, "follow-up answered", "follow-ups answered"),
  job_updated: (n) => plural(n, "job edited", "jobs edited"),
  job_deleted: (n) => plural(n, "job deleted", "jobs deleted"),
};

const LONG_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 11, 2026" from a YYYY-MM-DD key (no time zone conversion: the key already is the local date). */
export function longDate(key: string): string {
  return `${LONG_MONTHS[+key.slice(5, 7) - 1]} ${+key.slice(8, 10)}, ${key.slice(0, 4)}`;
}

/**
 * Work streak as of `date`: the number of consecutive calendar days, ending on `date`, that each
 * have at least one meaningful action. Only days up to `date` are looked at (history is never
 * rewritten by later activity). A day without qualifying work breaks the streak, and a visit or
 * login alone never counts. 0 when `date` itself has no qualifying work.
 */
export function workStreak(workDays: ReadonlySet<string>, date: string): number {
  let n = 0;
  for (let d = date; workDays.has(d); d = addDays(d, -1)) n += 1;
  return n;
}

const level = (n: number): HeatCell["level"] => (n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 8 ? 3 : 4);

export function describeDay(date: string, byAction: Partial<Record<ActivityAction, number>>, visits: number): string {
  const parts = MEANINGFUL_ACTIONS.filter((a) => byAction[a]).map((a) => PHRASES[a]!(byAction[a]!));
  const actions = Object.entries(byAction).reduce((s, [a, n]) => s + (isMeaningful(a as ActivityAction) ? n! : 0), 0);
  const head = `${date}: ${plural(actions, "action")}`;
  const summary = parts.length ? ` (${parts.join(", ")})` : "";
  const visited = visits > 0 ? `; ${plural(visits, "visit")}` : "";
  return `${head}${summary}${visited}`;
}

/**
 * Builds the heatmap grid and the real summary figures from the member's own persisted events.
 *
 * The grid is the CURRENT CALENDAR QUARTER (Jan-Mar, Apr-Jun, Jul-Sep or Oct-Dec) of `today` in
 * the application timezone, laid out in Monday-Sunday weeks. When the quarter ends, the next day's
 * timeline is automatically the next quarter (and year). Summary totals cover the quarter so far.
 */
export function buildActivityTimeline(
  events: ActivityEvent[],
  today: string,
  /** One calendar date per application the member marked Applied (from the Applications sheet). */
  appliedDates: string[] = [],
  /** One calendar date per job the member added (from the Jobs sheet). */
  addedDates: string[] = [],
): ActivityTimeline {
  const perDay = new Map<string, { byAction: Partial<Record<ActivityAction, number>>; actions: number; visits: number }>();
  // A retry or double-submit can only ever produce the SAME event (same action, job and server
  // timestamp); such duplicates are counted once so they cannot inflate a day's intensity.
  const seen = new Set<string>();
  for (const e of events) {
    if (e.jobId) {
      const key = `${e.action}|${e.jobId}|${e.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const day = perDay.get(e.date) ?? { byAction: {}, actions: 0, visits: 0 };
    day.byAction[e.action] = (day.byAction[e.action] ?? 0) + 1;
    if (isMeaningful(e.action)) day.actions += 1;
    else day.visits += 1;
    perDay.set(e.date, day);
  }

  // Days with qualifying work (visits/logins excluded), and how many jobs were marked Applied per day.
  const workDays = new Set<string>();
  for (const [date, day] of perDay) if (day.actions > 0) workDays.add(date);
  const submittedOn = new Map<string, number>();
  for (const d of appliedDates) submittedOn.set(d, (submittedOn.get(d) ?? 0) + 1);
  const addedOn = new Map<string, number>();
  for (const d of addedDates) addedOn.set(d, (addedOn.get(d) ?? 0) + 1);

  const quarter = quarterRange(today);
  const firstMonday = weekStart(quarter.start);
  const weekCount = Math.ceil((diffDays(quarter.end, firstMonday) + 1) / 7);
  const grid: (HeatCell | null)[][] = [];
  const s = { periodDays: 0, activeDays: 0, totalActions: 0, jobsAdded: 0, applied: 0, applicationUpdates: 0, visits: 0, daysVisited: 0 };

  for (let w = 0; w < weekCount; w++) {
    const monday = addDays(firstMonday, w * 7);
    const column: (HeatCell | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, d);
      if (date < quarter.start || date > quarter.end) {
        column.push(null); // belongs to the neighbouring quarter
        continue;
      }
      if (date > today) {
        column.push({ date, count: 0, visits: 0, level: 0, future: true, dateLabel: longDate(date), added: 0, submitted: 0, streak: 0, label: `${longDate(date)}: upcoming` });
        continue;
      }
      const day = perDay.get(date) ?? { byAction: {}, actions: 0, visits: 0 };
      s.periodDays += 1;
      s.totalActions += day.actions;
      s.visits += day.visits;
      if (day.actions > 0) s.activeDays += 1;
      if (day.visits > 0) s.daysVisited += 1; // days with a sign-in or visit event (presence), regardless of work
      s.jobsAdded += day.byAction.job_added ?? 0;
      s.applied += day.byAction.job_applied ?? 0;
      s.applicationUpdates += (day.byAction.application_updated ?? 0) + (day.byAction.job_unapplied ?? 0) + (day.byAction.follow_up_answered ?? 0);
      const added = addedOn.get(date) ?? 0;
      const submitted = submittedOn.get(date) ?? 0;
      const streak = workStreak(workDays, date);
      column.push({
        date, count: day.actions, visits: day.visits, level: level(day.actions), dateLabel: longDate(date), added, submitted, streak,
        label: `${describeDay(longDate(date), day.byAction, day.visits)}. Job added: ${added}. Job applied: ${submitted}. Streak: ${plural(streak, "day")}.`,
      });
    }
    grid.push(column);
  }

  // One label per month of the quarter, above the week that contains the 1st of that month.
  const monthLabels = [0, 1, 2].map((i) => {
    const first = `${quarter.start.slice(0, 5)}${String(+quarter.start.slice(5, 7) + i).padStart(2, "0")}-01`;
    return { column: Math.floor(diffDays(first, firstMonday) / 7), label: monthLabel(first) };
  });

  const activeSince = (days: number) => {
    const from = addDays(today, -(days - 1));
    let n = 0;
    for (const [date, day] of perDay) if (date >= from && date <= today && day.actions > 0) n += 1;
    return n;
  };
  const lastSeen = events.reduce<string | null>((max, e) => (max === null || e.timestamp > max ? e.timestamp : max), null);

  return {
    period: { start: quarter.start, end: quarter.end, label: quarter.label },
    weeks: grid,
    monthLabels,
    summary: { ...s, activeDaysLast7: activeSince(7), activeDaysLast30: activeSince(30), lastSeen },
  };
}
