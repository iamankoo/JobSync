import { describe, expect, it } from "vitest";
import { buildActivityTimeline, describeDay, isMeaningful, isPresence, MEANINGFUL_ACTIONS, PRESENCE_ACTIONS, type ActivityEvent } from "@/lib/analytics/activity";
import { classifyDeadline, orderDeadlines } from "@/lib/analytics/deadlines";
import { ageInDays, isExpired, RETENTION_DAYS, RETENTION_SECONDS, retentionDeadline } from "@/lib/retention/rules";
import { addDays } from "@/lib/analytics/dates";
import { ACTIVITY_ACTIONS } from "@/types/domain";

const TODAY = "2026-10-09"; // Friday
const ev = (date: string, action: ActivityEvent["action"], time = "10:00:00.000Z"): ActivityEvent => ({ date, action, timestamp: `${date}T${time}` });

describe("activity classification", () => {
  it("every action is either meaningful work or presence, never both", () => {
    for (const a of ACTIVITY_ACTIONS) expect(isMeaningful(a) !== isPresence(a), a).toBe(true);
    expect([...MEANINGFUL_ACTIONS, ...PRESENCE_ACTIONS].sort()).toEqual([...ACTIVITY_ACTIONS].sort());
    expect(PRESENCE_ACTIONS).toEqual(["login", "visit"]);
  });
});

describe("activity timeline (current calendar quarter)", () => {
  it("empty history: an empty grid for Oct-Dec, a zero summary and no last-seen", () => {
    const t = buildActivityTimeline([], TODAY);
    expect(t.period).toEqual({ start: "2026-10-01", end: "2026-12-31", label: "Oct–Dec 2026" });
    expect(t.weeks).toHaveLength(14);
    expect(t.weeks.every((w) => w.length === 7)).toBe(true);
    expect(t.summary).toMatchObject({ totalActions: 0, activeDays: 0, jobsAdded: 0, applied: 0, applicationUpdates: 0, visits: 0, daysVisited: 0, activeDaysLast7: 0, activeDaysLast30: 0, lastSeen: null });
    expect(t.summary.periodDays).toBe(9); // Oct 1 .. Oct 9
  });

  it("shows October, November and December in Monday-Sunday weeks; days outside the quarter are blank, later days are faint 'upcoming' cells", () => {
    const t = buildActivityTimeline([], TODAY);
    expect(t.monthLabels).toEqual([{ column: 0, label: "Oct" }, { column: 4, label: "Nov" }, { column: 9, label: "Dec" }]);
    // week 0 is Mon 28 Sep .. Sun 4 Oct: Sep days belong to the previous quarter
    expect(t.weeks[0].slice(0, 3)).toEqual([null, null, null]);
    expect(t.weeks[0][3]?.date).toBe("2026-10-01"); // Thursday
    // this week: today (Friday) is a real cell, the weekend after it is upcoming but still part of October
    expect(t.weeks[1][4]?.date).toBe(TODAY);
    expect(t.weeks[1][4]?.future).toBeUndefined();
    expect(t.weeks[1][5]).toMatchObject({ date: "2026-10-10", future: true, count: 0, label: "Oct 10, 2026: upcoming" });
    // the last week ends in the next year's quarter: Mon 28 - Thu 31 Dec, then blank
    const last = t.weeks.at(-1)!;
    expect(last[0]?.date).toBe("2026-12-28");
    expect(last[3]?.date).toBe("2026-12-31");
    expect(last.slice(4)).toEqual([null, null, null]);
  });

  it("moves to the next quarter and year by itself once December is over", () => {
    expect(buildActivityTimeline([], "2026-12-31").period.label).toBe("Oct–Dec 2026");
    const jan = buildActivityTimeline([], "2027-01-01");
    expect(jan.period).toEqual({ start: "2027-01-01", end: "2027-03-31", label: "Jan–Mar 2027" });
    expect(jan.monthLabels.map((m) => m.label)).toEqual(["Jan", "Feb", "Mar"]);
    expect(jan.summary.periodDays).toBe(1);
    // the quarter-to-date summary starts fresh, while 7/30-day figures still look back across the boundary
    const withOld = buildActivityTimeline([ev("2026-12-30", "job_added"), ev("2027-01-01", "job_added")], "2027-01-01");
    expect(withOld.summary).toMatchObject({ totalActions: 1, activeDays: 1, activeDaysLast7: 2, activeDaysLast30: 2 });
    // every quarter of the year, and a leap year
    const labels = ["2027-02-14", "2027-05-01", "2027-08-31", "2027-11-30", "2028-02-29", "2028-03-31", "2028-04-01"].map((d) => buildActivityTimeline([], d).period.label);
    expect(labels).toEqual(["Jan–Mar 2027", "Apr–Jun 2027", "Jul–Sep 2027", "Oct–Dec 2027", "Jan–Mar 2028", "Jan–Mar 2028", "Apr–Jun 2028"]);
    expect(buildActivityTimeline([], "2028-03-15").period.end).toBe("2028-03-31");
  });

  it("intensity uses meaningful actions only: 0, 1-2, 3-5, 6-8, 9+", () => {
    const events: ActivityEvent[] = [];
    const days = { "2026-10-09": 9, "2026-10-08": 8, "2026-10-07": 5, "2026-10-06": 3, "2026-10-05": 2, "2026-10-04": 1 };
    for (const [d, n] of Object.entries(days)) for (let i = 0; i < n; i++) events.push(ev(d, "job_added"));
    const cells = buildActivityTimeline(events, TODAY).weeks.flat().filter((c): c is NonNullable<typeof c> => c !== null);
    const level = (d: string) => cells.find((c) => c.date === d)!.level;
    expect([level("2026-10-09"), level("2026-10-08"), level("2026-10-07"), level("2026-10-06"), level("2026-10-05"), level("2026-10-04"), level("2026-10-03")]).toEqual([4, 3, 2, 2, 1, 1, 0]);
  });

  it("a visit alone is not work: no intensity, no action count, but it is shown and counted as a visit", () => {
    const t = buildActivityTimeline([ev(TODAY, "visit"), ev(TODAY, "login")], TODAY);
    const cell = t.weeks.flat().find((c) => c?.date === TODAY)!;
    expect(cell).toMatchObject({ count: 0, visits: 2, level: 0 });
    expect(cell.label).toBe("Oct 9, 2026: 0 actions; 2 visits. Job added: 0. Job applied: 0. Streak: 0 days.");
    expect(t.summary).toMatchObject({ totalActions: 0, jobsAdded: 0, applied: 0, activeDays: 0, visits: 2, daysVisited: 1, activeDaysLast7: 0 });
  });

  it("summary counts each kind of work separately and mixes with visits correctly (quarter to date)", () => {
    const events = [
      ev("2026-10-09", "job_added"), ev("2026-10-09", "job_added"), ev("2026-10-09", "job_applied"), ev("2026-10-09", "visit"),
      ev("2026-10-08", "job_unapplied"), ev("2026-10-08", "application_updated"), ev("2026-10-08", "follow_up_answered"),
      ev("2026-10-01", "job_updated"), ev("2026-09-20", "job_applied"),
    ];
    const s = buildActivityTimeline(events, TODAY).summary;
    // 20 Sep belongs to the previous quarter: not in the quarter totals, but inside the 30-day look-back
    expect(s).toMatchObject({ totalActions: 7, jobsAdded: 2, applied: 1, applicationUpdates: 3, visits: 1 });
    expect(s.activeDays).toBe(3);
    expect(s.activeDaysLast7).toBe(2); // Oct 3..9 -> Oct 8 and Oct 9
    expect(s.activeDaysLast30).toBe(4); // Sep 10..Oct 9 -> all four days
  });

  it("last seen is the newest event timestamp, whatever its kind", () => {
    const t = buildActivityTimeline([ev("2026-10-08", "job_added", "09:00:00.000Z"), ev("2026-10-09", "visit", "07:45:10.000Z"), ev("2026-10-07", "job_added", "23:00:00.000Z")], TODAY);
    expect(t.summary.lastSeen).toBe("2026-10-09T07:45:10.000Z");
  });

  it("events from before the quarter do not enter the quarter totals", () => {
    const t = buildActivityTimeline([ev("2026-09-30", "job_added"), ev("2026-10-01", "job_added")], TODAY);
    expect(t.summary.totalActions).toBe(1);
  });

  it("labels give the full date, count, summary, Job Added, Job Applied and streak", () => {
    const label = (events: ActivityEvent[], applied: string[] = [], added: string[] = []) =>
      buildActivityTimeline(events, TODAY, applied, added).weeks.flat().find((c) => c?.date === TODAY)!.label;
    expect(label([])).toBe("Oct 9, 2026: 0 actions. Job added: 0. Job applied: 0. Streak: 0 days.");
    expect(label([ev(TODAY, "job_added")], [], [TODAY])).toBe("Oct 9, 2026: 1 action (1 job added). Job added: 1. Job applied: 0. Streak: 1 day.");
    expect(label([ev(TODAY, "job_added", "01:00:00.000Z"), ev(TODAY, "job_added", "02:00:00.000Z"), ev(TODAY, "job_applied"), ev(TODAY, "follow_up_answered"), ev(TODAY, "visit")], [TODAY], [TODAY, TODAY])).toBe(
      "Oct 9, 2026: 4 actions (2 jobs added, 1 job marked applied, 1 follow-up answered); 1 visit. Job added: 2. Job applied: 1. Streak: 1 day.",
    );
    expect(describeDay("2026-10-09", { job_unapplied: 2, application_updated: 1 }, 0)).toBe("2026-10-09: 3 actions (2 jobs marked not applied, 1 application update)");
  });
});

describe("tooltip metrics: Job Added, Job Applied, Streak", () => {
  const cellOf = (events: ActivityEvent[], date: string, applied: string[] = [], added: string[] = [], today = TODAY) =>
    buildActivityTimeline(events, today, applied, added).weeks.flat().find((c) => c?.date === date)!;

  it("an empty day shows zero Job Added, zero Job Applied and a 0-day streak", () => {
    expect(cellOf([], "2026-10-05")).toMatchObject({ added: 0, submitted: 0, streak: 0, count: 0, level: 0 });
  });

  it("Job Added counts the member's jobs added on that calendar day (each job once); Job Applied counts applications marked Applied that day", () => {
    const c = cellOf([ev(TODAY, "job_added"), ev(TODAY, "job_added", "11:00:00.000Z"), ev(TODAY, "job_added", "12:00:00.000Z"), ev(TODAY, "job_applied"), ev(TODAY, "job_applied", "13:00:00.000Z")], TODAY,
      [TODAY, TODAY], [TODAY, TODAY, TODAY]);
    expect(c).toMatchObject({ added: 3, submitted: 2, count: 5, level: 2 });
  });

  it("other days are not mixed in", () => {
    const c = cellOf([], "2026-10-07", ["2026-10-07", "2026-10-08", "2026-10-09"], ["2026-10-06", "2026-10-07", "2026-10-07"]);
    expect(c).toMatchObject({ added: 2, submitted: 1 });
  });

  it("merely adding a job is not a submission, and submitting is not an addition", () => {
    expect(cellOf([ev(TODAY, "job_added")], TODAY, [], [TODAY])).toMatchObject({ added: 1, submitted: 0 });
    expect(cellOf([ev(TODAY, "job_applied")], TODAY, [TODAY], [])).toMatchObject({ added: 0, submitted: 1 });
  });

  it("duplicate (retried) events are counted once in the intensity; genuinely different events are not merged", () => {
    const dup = { ...ev(TODAY, "job_added"), jobId: "job_1" };
    expect(cellOf([dup, { ...dup }, { ...dup }], TODAY).count).toBe(1);
    expect(cellOf([dup, { ...ev(TODAY, "job_added", "10:00:01.000Z"), jobId: "job_1" }, { ...dup, jobId: "job_2" }], TODAY).count).toBe(3);
  });

  it("streak counts consecutive days with qualifying work ending on that day", () => {
    const events = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"].map((d) => ev(d, "job_added"));
    const c = (d: string) => cellOf(events, d).streak;
    expect([c("2026-10-05"), c("2026-10-06"), c("2026-10-07"), c("2026-10-08"), c("2026-10-09")]).toEqual([0, 1, 2, 3, 4]);
  });

  it("a day without qualifying work breaks the streak, and the streak restarts from 1", () => {
    const events = ["2026-10-02", "2026-10-03", "2026-10-04", /* gap on the 5th */ "2026-10-06", "2026-10-07"].map((d) => ev(d, "job_applied"));
    const c = (d: string) => cellOf(events, d).streak;
    expect([c("2026-10-04"), c("2026-10-05"), c("2026-10-06"), c("2026-10-07")]).toEqual([3, 0, 1, 2]);
  });

  it("is calculated historically: later activity never changes an earlier day's streak", () => {
    const early = ["2026-10-02", "2026-10-03"].map((d) => ev(d, "job_added"));
    const later = [...early, ...["2026-10-04", "2026-10-05", "2026-10-06"].map((d) => ev(d, "job_added"))];
    expect(cellOf(early, "2026-10-03").streak).toBe(2);
    expect(cellOf(later, "2026-10-03").streak).toBe(2); // unchanged by what happened afterwards
    expect(cellOf(later, "2026-10-06").streak).toBe(5);
  });

  it("visits and logins alone never build a streak; work on a visit day does", () => {
    const events = [ev("2026-10-06", "visit"), ev("2026-10-07", "login"), ev("2026-10-08", "visit"), ev("2026-10-08", "job_added")];
    expect(cellOf(events, "2026-10-07").streak).toBe(0);
    expect(cellOf(events, "2026-10-08").streak).toBe(1); // the 7th had only a login: it does not extend the run
  });

  it("every kind of meaningful action qualifies", () => {
    for (const action of MEANINGFUL_ACTIONS) expect(cellOf([ev(TODAY, action)], TODAY).streak, action).toBe(1);
  });

  it("a streak continues across the start of a new quarter, month and year", () => {
    const events = ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"].map((d) => ev(d, "job_added"));
    const c = (d: string) => cellOf(events, d, [], [], "2027-01-10").streak;
    expect([c("2027-01-01"), c("2027-01-02")]).toEqual([3, 4]);
  });

  it("days that have not happened yet carry no numbers", () => {
    expect(cellOf([], "2026-10-10")).toMatchObject({ future: true, added: 0, submitted: 0, streak: 0 });
  });

  it("long dates are formatted as 'Oct 11, 2026'", () => {
    expect(cellOf([], "2026-10-05").dateLabel).toBe("Oct 5, 2026");
    expect(buildActivityTimeline([], "2026-12-15").weeks.flat().find((c) => c?.date === "2026-12-31")!.dateLabel).toBe("Dec 31, 2026");
  });
});

describe("deadline rules", () => {
  it("classifies past, today and upcoming using the date in the app timezone", () => {
    expect(classifyDeadline("2026-10-08", TODAY)).toMatchObject({ state: "past", days: -1, remaining: "Passed 1 day ago", approaching: false });
    expect(classifyDeadline("2026-10-09", TODAY)).toMatchObject({ state: "today", days: 0, remaining: "Due today", approaching: true });
    expect(classifyDeadline("2026-10-10", TODAY)).toMatchObject({ state: "upcoming", days: 1, remaining: "1 day left", approaching: true });
    expect(classifyDeadline("2026-10-12", TODAY)).toMatchObject({ state: "upcoming", remaining: "3 days left", approaching: true });
    expect(classifyDeadline("2026-10-13", TODAY)).toMatchObject({ state: "upcoming", remaining: "4 days left", approaching: false });
    expect(classifyDeadline("2026-09-20", TODAY).remaining).toBe("Passed 19 days ago");
  });

  it("orders nearest upcoming first, then the most recent past ones (capped)", () => {
    const items = ["2026-10-20", "2026-10-09", "2026-10-01", "2026-10-12", "2026-10-07", "2026-09-01", "2026-10-08", "2026-10-02"].map((deadline, i) => ({ jobId: `j${i}`, deadline }));
    const ordered = orderDeadlines(items, TODAY, 3).map((i) => i.deadline);
    expect(ordered).toEqual(["2026-10-09", "2026-10-12", "2026-10-20", "2026-10-08", "2026-10-07", "2026-10-02"]);
  });

  it("handles month and year boundaries", () => {
    expect(classifyDeadline("2027-01-02", "2026-12-31")).toMatchObject({ state: "upcoming", days: 2 });
    expect(classifyDeadline("2026-03-01", "2026-02-28").days).toBe(1);
  });
});

describe("30-day retention rule", () => {
  it("is exactly 30 x 24 hours (2,592,000 seconds) from AddedAt", () => {
    expect(RETENTION_DAYS).toBe(30);
    expect(RETENTION_SECONDS).toBe(2_592_000);
    expect(retentionDeadline("2026-09-09T10:00:00.000Z")?.toISOString()).toBe("2026-10-09T10:00:00.000Z");
  });

  it("is not expired 1 ms before, and expired at and after the deadline", () => {
    const added = "2026-09-09T10:00:00.000Z";
    expect(isExpired(added, new Date("2026-10-09T09:59:59.999Z"))).toBe(false);
    expect(isExpired(added, new Date("2026-10-09T10:00:00.000Z"))).toBe(true);
    expect(isExpired(added, new Date("2026-12-01T00:00:00.000Z"))).toBe(true);
  });

  it("invalid, missing or future timestamps are NEVER expired (so bad data can never cause a deletion)", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    for (const bad of [undefined, "", "yesterday", "2026-13-45T00:00:00Z", "2026-09-09", "2026-09-09 10:00", "9999-99-99T00:00:00Z"]) {
      expect(isExpired(bad, now), String(bad)).toBe(false);
      expect(retentionDeadline(bad)).toBeNull();
      expect(ageInDays(bad, now)).toBeNull();
    }
    expect(isExpired("2031-01-01T00:00:00.000Z", now)).toBe(false); // added "in the future" (clock skew)
  });

  it("reports whole days of age", () => {
    expect(ageInDays("2026-09-09T10:00:00.000Z", new Date("2026-10-11T09:00:00.000Z"))).toBe(31);
  });

  it("date helper sanity used by the tests", () => {
    expect(addDays(TODAY, -30)).toBe("2026-09-09");
  });
});
