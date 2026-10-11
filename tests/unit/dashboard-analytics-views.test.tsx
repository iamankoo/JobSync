// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnalyticsView } from "@/components/analytics/analytics-view";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { getMember } from "@/config/members";
import { buildDashboard } from "@/lib/analytics/dashboard";
import { addDays } from "@/lib/analytics/dates";
import type { ApplicationStatus } from "@/types/domain";
import type { AnalyticsApplication, AnalyticsSource } from "@/types/insights";
import { makeJob } from "../helpers/fixtures";

const TODAY = "2026-10-09";
const TZ = "Asia/Kolkata";

const jobs = Array.from({ length: 6 }, (_, i) =>
  makeJob(i + 1, { addedBy: (["anni", "lukky", "rishii"] as const)[i % 3], addedAt: `${addDays(TODAY, -(i % 3))}T05:00:00.000Z`, deadline: addDays(TODAY, i + 1) }),
);
const mine: { jobId: string; status: ApplicationStatus; appliedDate?: string }[] = [
  { jobId: "job_1", status: "Applied", appliedDate: TODAY },
  { jobId: "job_2", status: "Interview", appliedDate: TODAY },
];
const dashboard = (over = {}) => buildDashboard({ memberId: "anni", jobs, myApplications: mine, activeMembers: ["anni", "lukky", "rishii"], today: TODAY, timeZone: TZ, ...over });
const renderDash = (data = dashboard(), member: "anni" | "lukky" | "rishii" = "anni") => render(<DashboardView member={getMember(member)!} data={data} timeZone={TZ} />);

describe("DashboardView", () => {
  it("greets the signed-in member by name and shows real counts", () => {
    renderDash();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Welcome back, Anni");
    const overview = within(screen.getByRole("region", { name: "Overview" }));
    expect(overview.getByText("Total Jobs").nextElementSibling).toHaveTextContent("6");
    expect(overview.getByText("My Applications").nextElementSibling).toHaveTextContent("2");
    expect(overview.getByText("Pending").nextElementSibling).toHaveTextContent("2");
    expect(overview.getByText("Team Members").nextElementSibling).toHaveTextContent("3");
    expect(overview.getByText("Anni, Lukky, Rishii")).toBeInTheDocument();
  });

  it("is personal: another member sees the same shared totals but their own application counts", () => {
    renderDash(dashboard({ memberId: "lukky", myApplications: [] }), "lukky");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Welcome back, Lukky");
    const overview = within(screen.getByRole("region", { name: "Overview" }));
    expect(overview.getByText("Total Jobs").nextElementSibling).toHaveTextContent("6");
    expect(overview.getByText("My Applications").nextElementSibling).toHaveTextContent("0");
  });

  it("daily target shows progress toward 10 with an accessible progress bar", () => {
    renderDash(); // anni added jobs 1 and 4, both within the last 3 days; job_1 and job_4 -> today only job_1/job_4?
    const bar = screen.getByRole("progressbar", { name: "Daily target progress" });
    const added = dashboard().daily.addedToday;
    expect(bar).toHaveAttribute("aria-valuenow", String(added * 10));
    expect(screen.getByLabelText(new RegExp(`${added} of 10 jobs added today`))).toBeInTheDocument();
    expect(screen.getByText("Added today")).toBeInTheDocument();
    expect(screen.getByText("Shortlisted")).toBeInTheDocument();
  });

  it("team contribution: switching the period updates the chart", async () => {
    const user = userEvent.setup();
    renderDash();
    const chart = () => screen.getByRole("img", { name: /^Jobs added, / });
    expect(chart()).toHaveAccessibleName(/This Week/);
    await user.selectOptions(screen.getByLabelText("Period"), "all");
    expect(chart()).toHaveAccessibleName("Jobs added, All Time: Anni 2, Lukky 2, Rishii 2");
    await user.selectOptions(screen.getByLabelText("Period"), "month");
    expect(chart()).toHaveAccessibleName(/This Month/);
  });

  it("recent jobs show who added them and whether I applied; links go to real pages", () => {
    renderDash();
    const table = within(screen.getByRole("table", { name: "Most recently added jobs" }));
    const rows = table.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    const first = within(rows.find((r) => within(r).queryByText("Test Role 1"))!);
    expect(first.getByText("Yes")).toBeInTheDocument();
    expect(first.getByText("Anni")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Test Role 1" })).toHaveAttribute("href", "/all-jobs?q=Test%20Role%201");
    expect(screen.getByRole("link", { name: /Add New Job$/ , hidden: false })).toBeTruthy();
  });

  it("upcoming deadlines list open jobs with a day count", () => {
    renderDash();
    const section = within(screen.getByRole("region", { name: "Upcoming Deadlines" }));
    // job_1 and job_2 are applied, so the soonest open deadline is job_3 (+3 days), then job_4 (+4) ...
    expect(section.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Test Role 3"), expect.stringContaining("Test Role 4"), expect.stringContaining("Test Role 5"), expect.stringContaining("Test Role 6"),
    ]);
    expect(section.getByText("3 days")).toBeInTheDocument();
    expect(section.getByText("6 days")).toBeInTheDocument();
  });

  it("empty database: zero counts, 'No jobs yet' with Add New Job, honest empty deadlines, no invented jobs", () => {
    renderDash(dashboard({ jobs: [], myApplications: [] }));
    expect(screen.getByRole("heading", { name: "No jobs yet" })).toBeInTheDocument();
    expect(screen.getByText(/No upcoming deadlines/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Add New Job/ }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/No jobs added/)).toBeInTheDocument();
  });

  it("quick actions link to the three real destinations", () => {
    renderDash();
    const qa = within(screen.getByRole("region", { name: "Quick Actions" }));
    expect(qa.getByRole("link", { name: /Add New Job/ })).toHaveAttribute("href", "/add-job");
    expect(qa.getByRole("link", { name: /Browse All Jobs/ })).toHaveAttribute("href", "/all-jobs");
    expect(qa.getByRole("link", { name: /My Applications/ })).toHaveAttribute("href", "/my-applications");
  });
});

const app = (jobId: string, status: ApplicationStatus, daysAgo: number, over: Partial<AnalyticsApplication> = {}): AnalyticsApplication => ({
  jobId, status, appliedDate: addDays(TODAY, -daysAgo), company: "Synthetic Co A", jobType: "Full-time", location: "Testville", experience: "0–1 years", ...over,
});
const source = (applications: AnalyticsApplication[], over: Partial<AnalyticsSource> = {}): AnalyticsSource => ({ applications, totalJobs: applications.length, openDeadlines: [], noDeadlineCount: 0, activity: [], addedDates: [], today: TODAY, ...over });

describe("AnalyticsView", () => {
  const apps = [
    app("1", "Applied", 2), app("2", "Applied", 3), app("3", "In Progress", 5), app("4", "Interview", 10), app("5", "Rejected", 40), app("6", "Offer", 60),
  ];
  const totals = () => within(screen.getByRole("region", { name: "Application totals" }));
  const card = (label: string) => totals().getByText(label).previousElementSibling!.textContent;

  it("computes the cards from the member's applications for the chosen range", async () => {
    const user = userEvent.setup();
    render(<AnalyticsView source={source(apps)} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Analytics");
    // default range: last 30 days -> apps 1-4
    expect(card("Total Applications")).toBe("6"); // all shared jobs, not range-limited
    expect(card("Applied")).toBe("4"); // all applications; In Progress/Interview are part of Applied, not extra
    expect(card("Interviewed")).toBe("1");
    expect(card("Rejected")).toBe("0");

    await user.selectOptions(screen.getByLabelText("Time range"), "7");
    expect(card("Total Applications")).toBe("6"); // shared total: not range-limited
    expect(card("Applied")).toBe("3"); // applied 2, 3 and 5 days ago
    await user.selectOptions(screen.getByLabelText("Time range"), "all");
    expect(card("Applied")).toBe("6");
    expect(card("Offers")).toBe("1");
    expect(card("Rejected")).toBe("1");
  });

  it("shows the comparison with the previous period only when there is one", async () => {
    const user = userEvent.setup();
    render(<AnalyticsView source={source(apps)} />);
    expect(totals().getAllByText(/vs previous 30 days/).length).toBeGreaterThan(0);
    await user.selectOptions(screen.getByLabelText("Time range"), "all");
    expect(totals().queryByText(/vs previous/)).not.toBeInTheDocument();
  });

  it("renders every analysis section from real data, with the response rate", () => {
    render(<AnalyticsView source={source(apps)} />);
    for (const name of [
      "Application Status Distribution", "Applications Over Time", "Response Rate", "Job Type Distribution", "Top Companies (Applied)",
      "Location Distribution", "Experience Level Distribution", "Application Timeline", "Deadlines Overview",
    ]) expect(screen.getByRole("region", { name })).toBeInTheDocument();
    // 30-day window: 4 applications, 2 got a response (In Progress, Interview) -> 50%
    expect(within(screen.getByRole("region", { name: "Response Rate" })).getByText("2 out of 4 applications received a response")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Response Rate: 50%" })).toBeInTheDocument();
  });

  it("applications over time: legend toggles work inside the view", async () => {
    const user = userEvent.setup();
    render(<AnalyticsView source={source(apps)} />);
    const trend = within(screen.getByRole("region", { name: "Applications Over Time" }));
    const rejected = trend.getByRole("button", { name: "Rejected" });
    expect(rejected).toHaveAttribute("aria-pressed", "true");
    await user.click(rejected);
    expect(rejected).toHaveAttribute("aria-pressed", "false");
  });

  it("no applications at all: zero cards, a designed empty state with a working link, and no charts of nothing", () => {
    render(<AnalyticsView source={source([])} />);
    expect(card("Total Applications")).toBe("0");
    expect(screen.getByRole("heading", { name: "No applications yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse All Jobs" })).toHaveAttribute("href", "/all-jobs");
    expect(screen.queryByRole("region", { name: "Application Status Distribution" })).not.toBeInTheDocument();
    // sections that do not need applications still render honestly
    expect(screen.getByRole("region", { name: "Application Timeline" })).toBeInTheDocument();
    expect(screen.getByText(/No activity recorded yet/)).toBeInTheDocument();
    expect(screen.getByText(/No upcoming deadlines for jobs you haven/)).toBeInTheDocument();
  });

  it("applications exist but none in the chosen period: says so and keeps zero charts", async () => {
    const user = userEvent.setup();
    render(<AnalyticsView source={source([app("1", "Applied", 80)])} />);
    expect(screen.getByRole("status")).toHaveTextContent(/haven't applied to anything in this period/);
    await user.selectOptions(screen.getByLabelText("Time range"), "all");
    expect(screen.queryByText(/haven't applied to anything in this period/)).not.toBeInTheDocument();
  });

  it("deadlines overview counts only open jobs the member has not applied to", () => {
    const deadlines = [2, 5, 9, 20].map((d, i) => ({ jobId: `d${i}`, company: "C", jobRole: "R", deadline: addDays(TODAY, d) }));
    render(<AnalyticsView source={source(apps, { openDeadlines: deadlines })} />);
    const panel = within(screen.getByRole("region", { name: "Deadlines Overview" }));
    expect(panel.getByRole("img", { name: /Upcoming deadlines:/ })).toHaveAccessibleName("Upcoming deadlines: Within 3 days 1, 4–7 days 1, 8–14 days 1, 15+ days 1");
    expect(panel.getAllByText("Upcoming Deadlines").length).toBeGreaterThan(0);
  });
});
