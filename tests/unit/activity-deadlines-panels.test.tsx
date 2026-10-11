// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ActivityPanel } from "@/components/analytics/activity-panel";
import { DeadlinesPanel } from "@/components/analytics/deadlines-panel";
import { buildActivityTimeline, type ActivityEvent } from "@/lib/analytics/activity";
import { computeAnalytics } from "@/lib/analytics/analytics";
import { addDays } from "@/lib/analytics/dates";
import type { AnalyticsSource } from "@/types/insights";

const TODAY = "2026-10-09";
const ev = (date: string, action: ActivityEvent["action"], time = "10:00:00.000Z"): ActivityEvent => ({ date, action, timestamp: `${date}T${time}` });

describe("ActivityPanel (Application Timeline)", () => {
  it("shows only the heatmap: quarter heading, month and weekday labels and the legend", () => {
    render(<ActivityPanel timeline={buildActivityTimeline([], TODAY)} />);
    expect(screen.getByText("Oct–Dec 2026")).toBeInTheDocument();
    expect(screen.getByLabelText("Activity for Oct–Dec 2026: 0 meaningful actions so far")).toBeInTheDocument();
    for (const month of ["Oct", "Nov", "Dec"]) expect(screen.getByText(month)).toBeInTheDocument();
    for (const day of ["Mon", "Wed", "Fri", "Sun"]) expect(screen.getByText(day)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Legend: meaningful actions per day" })).toBeInTheDocument();
  });

  it("the summary cards and the explanatory footer are gone", () => {
    render(<ActivityPanel timeline={buildActivityTimeline([ev(TODAY, "job_added"), ev(TODAY, "visit")], TODAY)} />);
    for (const label of [
      "Last seen", "Active days (7 days)", "Active days (30 days)", "Active days (this quarter)", "Meaningful actions", "Jobs added", "Marked applied",
      "Updates & follow-ups", "Visits",
    ]) expect(screen.queryByText(label)).not.toBeInTheDocument();
    expect(screen.queryByText(/Visits are not work/)).not.toBeInTheDocument();
    expect(document.querySelector("dl")).toBeNull();
  });

  it("switches to the next quarter and year automatically", () => {
    render(<ActivityPanel timeline={buildActivityTimeline([], "2027-01-01")} />);
    expect(screen.getByText("Jan–Mar 2027")).toBeInTheDocument();
    for (const month of ["Jan", "Feb", "Mar"]) expect(screen.getByText(month)).toBeInTheDocument();
    expect(screen.queryByText("Oct")).not.toBeInTheDocument();
  });

  it("an honest empty hint when nothing has been recorded", () => {
    render(<ActivityPanel timeline={buildActivityTimeline([], TODAY)} />);
    expect(screen.getByText(/No activity recorded yet/)).toBeInTheDocument();
  });

  it("every day has an accessible label with its date, counts and tooltip metrics", () => {
    render(<ActivityPanel timeline={buildActivityTimeline([ev(TODAY, "job_added"), ev(TODAY, "visit")], TODAY, [], [TODAY])} />);
    expect(screen.getByRole("img", { name: "Oct 9, 2026: 1 action (1 job added); 1 visit. Job added: 1. Job applied: 0. Streak: 1 day." })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Oct 8, 2026: 0 actions. Job added: 0. Job applied: 0. Streak: 0 days." })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Oct 10, 2026: upcoming" })).toBeInTheDocument();
  });
});

const source = (openDeadlines: AnalyticsSource["openDeadlines"], noDeadlineCount = 0): AnalyticsSource => ({
  applications: [], totalJobs: 0, openDeadlines, noDeadlineCount, activity: [], addedDates: [], today: TODAY,
});
const dl = (id: string, offset: number, role = `Test Role ${id}`) => ({ jobId: id, company: `Synthetic Co ${id}`, jobRole: role, deadline: addDays(TODAY, offset) });
const panel = (s: AnalyticsSource) => render(<DeadlinesPanel deadlines={computeAnalytics(s, 30).deadlines} timeZone="Asia/Kolkata" />);

describe("DeadlinesPanel (Deadlines Overview)", () => {
  it("empty: a clear message and no invented deadlines", () => {
    panel(source([]));
    expect(screen.getByText(/No upcoming deadlines for jobs you haven't applied to/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("lists upcoming deadlines nearest first with company, role, date, remaining time and a link to the job", () => {
    panel(source([dl("c", 20), dl("a", 0), dl("b", 3), dl("d", 1)]));
    const upcoming = within(screen.getByRole("region", { name: "Upcoming deadlines list" }));
    const rows = upcoming.getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Test Role a"), expect.stringContaining("Test Role d"), expect.stringContaining("Test Role b"), expect.stringContaining("Test Role c"),
    ]);
    expect(within(rows[0]).getByText("Due today")).toBeInTheDocument();
    expect(within(rows[1]).getByText("1 day left")).toBeInTheDocument();
    expect(within(rows[2]).getByText("3 days left")).toBeInTheDocument();
    expect(within(rows[3]).getByText("20 days left")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Synthetic Co a")).toBeInTheDocument();
    expect(within(rows[0]).getByText("09 Oct 2026")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("link")).toHaveAttribute("href", "/all-jobs?q=Test%20Role%20a");
  });

  it("shows past deadlines separately and clearly labelled, most recent first", () => {
    panel(source([dl("a", 5), dl("p1", -2), dl("p2", -9)]));
    const past = within(screen.getByRole("region", { name: "Past deadlines" }));
    expect(past.getAllByRole("listitem").map((r) => r.textContent)).toEqual([expect.stringContaining("Test Role p1"), expect.stringContaining("Test Role p2")]);
    expect(past.getByText("Passed 2 days ago")).toBeInTheDocument();
    expect(past.getByText("Passed 9 days ago")).toBeInTheDocument();
  });

  it("only past deadlines: still listed, with no donut of 'upcoming'", () => {
    panel(source([dl("p1", -2)]));
    expect(screen.queryByRole("img", { name: /Upcoming deadlines:/ })).not.toBeInTheDocument();
    expect(screen.getByText("Passed 2 days ago")).toBeInTheDocument();
  });

  it("states how many open jobs have no deadline instead of inventing one", () => {
    panel(source([dl("a", 2)], 3));
    expect(screen.getByText("3 open jobs have no deadline listed.")).toBeInTheDocument();
    panel(source([], 1));
    expect(screen.getAllByText("1 open job has no deadline listed.").length).toBeGreaterThan(0);
  });

  it("the overview chart counts only upcoming deadlines (today included)", () => {
    panel(source([dl("a", 0), dl("b", 5), dl("c", 10), dl("d", 30), dl("p", -3)]));
    expect(screen.getByRole("img", { name: "Upcoming deadlines: Within 3 days 1, 4–7 days 1, 8–14 days 1, 15+ days 1" })).toBeInTheDocument();
  });
});
