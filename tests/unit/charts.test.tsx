// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BarChart } from "@/components/charts/bar-chart";
import { DonutChart } from "@/components/charts/donut-chart";
import { Heatmap } from "@/components/charts/heatmap";
import { RingGauge } from "@/components/charts/ring-gauge";
import { Sparkline } from "@/components/charts/sparkline";
import { TrendChart } from "@/components/charts/trend-chart";
import { niceMax } from "@/components/charts/colors";

describe("DonutChart", () => {
  const slices = [
    { label: "Applied", value: 6, color: "#3b82f6" },
    { label: "Rejected", value: 2, color: "#ef4444" },
    { label: "Offer", value: 0, color: "#a78bfa" },
  ];

  it("lists each slice with its value and percentage, and summarises itself for screen readers", () => {
    render(<DonutChart slices={slices} centerValue={8} centerLabel="Applications" ariaLabel="Status" />);
    expect(screen.getByRole("img")).toHaveAccessibleName("Status: Applied 6, Rejected 2");
    const items = screen.getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["Applied6 (75%)", "Rejected2 (25%)", "Offer0 (0%)"]);
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("Applications")).toBeInTheDocument();
  });

  it("hover or focus on a legend row shows that slice in the centre; leaving restores the total", async () => {
    const user = userEvent.setup();
    render(<DonutChart slices={slices} centerValue={8} centerLabel="Applications" ariaLabel="Status" />);
    const rejected = screen.getAllByRole("listitem")[1];
    await user.hover(rejected);
    expect(screen.getByText("Rejected", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("2", { selector: "p" })).toBeInTheDocument();
    await user.unhover(rejected);
    expect(screen.getByText("8", { selector: "p" })).toBeInTheDocument();
    await user.tab();
    await user.tab(); // moves focus along the legend rows
    expect(document.activeElement?.tagName).toBe("LI");
  });

  it("with no data draws no segments and says so", () => {
    const { container } = render(<DonutChart slices={slices.map((s) => ({ ...s, value: 0 }))} centerValue={0} centerLabel="Applications" ariaLabel="Status" />);
    expect(screen.getByRole("img")).toHaveAccessibleName("Status: no data");
    expect(container.querySelectorAll("svg circle")).toHaveLength(1); // just the track
  });
});

describe("TrendChart", () => {
  const props = {
    ariaLabel: "Applications over time",
    labels: ["1 Oct", "2 Oct", "3 Oct", "4 Oct"],
    series: [
      { key: "Applied", label: "Applied", color: "#3b82f6", values: [0, 1, 2, 4] },
      { key: "Rejected", label: "Rejected", color: "#ef4444", values: [0, 0, 1, 1] },
    ],
  };

  it("legend buttons show and hide series", async () => {
    const user = userEvent.setup();
    const { container } = render(<TrendChart {...props} />);
    expect(container.querySelectorAll("svg polyline")).toHaveLength(2);
    const applied = screen.getByRole("button", { name: "Applied" });
    expect(applied).toHaveAttribute("aria-pressed", "true");
    await user.click(applied);
    expect(applied).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelectorAll("svg polyline")).toHaveLength(1);
    await user.click(applied);
    expect(container.querySelectorAll("svg polyline")).toHaveLength(2);
  });

  it("arrow keys read each day: the tooltip lists the visible series' values, Escape clears it", async () => {
    const user = userEvent.setup();
    render(<TrendChart {...props} />);
    screen.getByRole("group", { name: /Applications over time/ }).focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    const tip = screen.getByRole("status");
    expect(within(tip).getByText("3 Oct")).toBeInTheDocument();
    expect(within(tip).getByText("Applied").parentElement).toHaveTextContent("2");
    expect(within(tip).getByText("Rejected").parentElement).toHaveTextContent("1");
    await user.keyboard("{ArrowLeft}");
    expect(within(screen.getByRole("status")).getByText("2 Oct")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("hidden series disappear from the tooltip", async () => {
    const user = userEvent.setup();
    render(<TrendChart {...props} />);
    await user.click(screen.getByRole("button", { name: "Rejected" }));
    screen.getByRole("group").focus();
    await user.keyboard("{ArrowRight}");
    expect(within(screen.getByRole("status")).queryByText("Rejected")).not.toBeInTheDocument();
  });

  it("copes with a single day of data", () => {
    render(<TrendChart ariaLabel="t" labels={["1 Oct"]} series={[{ key: "a", label: "A", color: "#fff", values: [0] }]} />);
    expect(screen.getByRole("group")).toBeInTheDocument();
  });
});

describe("BarChart", () => {
  it("draws one labelled bar per item with its value", () => {
    render(<BarChart ariaLabel="Jobs added" bars={[{ label: "Anni", value: 8, color: "#2f6bff" }, { label: "Lukky", value: 0, color: "#f5c518" }]} />);
    expect(screen.getByRole("img")).toHaveAccessibleName("Jobs added: Anni 8, Lukky 0");
    expect(screen.getByText("Anni")).toBeInTheDocument();
    expect(screen.getAllByText("8").length).toBeGreaterThanOrEqual(1); // bar label (and possibly an axis tick)
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(1);
  });

  it("scales its axis to the data using round numbers", () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(3)).toBe(4);
    expect(niceMax(7)).toBe(8);
    expect(niceMax(9)).toBe(10);
    expect(niceMax(11)).toBe(20);
    expect(niceMax(73)).toBe(80);
  });

  it("highlights a bar on focus", async () => {
    const user = userEvent.setup();
    const { container } = render(<BarChart ariaLabel="x" bars={[{ label: "A", value: 2, color: "#fff" }, { label: "B", value: 3, color: "#fff" }]} />);
    const before = container.querySelectorAll("rect").length;
    await user.tab();
    expect(container.querySelectorAll("rect").length).toBe(before + 1); // outline rect for the active bar
  });
});

describe("RingGauge, Sparkline and Heatmap", () => {
  it("shows the percentage, or a dash when there is no data", () => {
    const { rerender } = render(<RingGauge percent={22} label="Response Rate" caption="4 out of 18 applications received a response" />);
    expect(screen.getByRole("img")).toHaveAccessibleName("Response Rate: 22%");
    expect(screen.getByText("22%")).toBeInTheDocument();
    rerender(<RingGauge percent={null} label="Response Rate" caption="No applications in this period" />);
    expect(screen.getByRole("img")).toHaveAccessibleName("Response Rate: no data");
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("sparkline draws a flat, dimmed line for all-zero data", () => {
    const { container } = render(<Sparkline values={[0, 0, 0, 0, 0, 0, 0]} color="#fff" label="Jobs per day" />);
    const line = container.querySelector("polyline")!;
    expect(line.getAttribute("opacity")).toBe("0.4");
    const ys = new Set(line.getAttribute("points")!.split(" ").map((p) => p.split(",")[1]));
    expect(ys.size).toBe(1);
  });

  it("heatmap labels every day with date, count, summary and the tooltip metrics, and keeps future days faint", () => {
    const cell = (date: string, count: number, visits: number, level: 0 | 1 | 2 | 3 | 4, label: string) => ({ date, dateLabel: date, added: 0, submitted: 0, streak: 0, count, visits, level, label });
    const weeks = [[
      cell("2026-10-05", 3, 1, 2, "Oct 5, 2026: 3 actions (2 jobs added, 1 job marked applied); 1 visit. Job added: 2. Job applied: 1. Streak: 1 day."),
      cell("2026-10-06", 0, 1, 0, "Oct 6, 2026: 0 actions; 1 visit. Job added: 0. Job applied: 0. Streak: 0 days."),
      { ...cell("2026-10-07", 0, 0, 0, "Oct 7, 2026: upcoming"), future: true },
      null, null, null, null,
    ]];
    render(<Heatmap weeks={weeks} monthLabels={[{ column: 0, label: "Oct" }]} totalActions={3} periodLabel="Oct–Dec 2026" />);
    expect(screen.getByRole("img", { name: /^Oct 5, 2026: 3 actions \(2 jobs added, 1 job marked applied\); 1 visit\. Job added: 2\. Job applied: 1\. Streak: 1 day\.$/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Oct 6, 2026: 0 actions/ })).toHaveAttribute("data-level", "0");
    expect(screen.getByLabelText("Activity for Oct–Dec 2026: 3 meaningful actions so far")).toBeInTheDocument();
    expect(screen.getByText("visit only")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Oct 7, 2026: upcoming" })).toBeInTheDocument();
  });

  describe("heatmap tooltip", () => {
    const mk = (date: string, dateLabel: string, added: number, submitted: number, streak: number) => ({
      date, dateLabel, added, submitted, streak, count: added + submitted, visits: 0, level: 1 as const, label: `${dateLabel} cell`,
    });
    const weeks = [[mk("2026-10-05", "Oct 5, 2026", 4, 3, 4), mk("2026-10-06", "Oct 6, 2026", 0, 0, 0), null, null, null, null, null]];
    const draw = () => render(<Heatmap weeks={weeks} monthLabels={[]} totalActions={7} periodLabel="Oct–Dec 2026" />);

    it("shows date, Job Added, Job Applied and streak on keyboard focus and hides on blur", async () => {
      draw();
      await userEvent.tab();
      const tip = screen.getByRole("tooltip");
      expect(tip).toHaveTextContent("Date: Oct 5, 2026");
      expect(tip).toHaveTextContent("Job Added: 4");
      expect(tip).toHaveTextContent("Job Applied: 3");
      expect(tip).toHaveTextContent("Streak: 4 days");
      await userEvent.tab();
      expect(screen.getByRole("tooltip")).toHaveTextContent("Oct 6, 2026");
      expect(screen.getByRole("tooltip")).toHaveTextContent("Streak: 0 days");
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("shows on hover and on tap/click, and tapping elsewhere closes it", async () => {
      draw();
      await userEvent.hover(screen.getByLabelText("Oct 6, 2026 cell"));
      expect(screen.getByRole("tooltip")).toHaveTextContent("Job Applied: 0");
      await userEvent.unhover(screen.getByLabelText("Oct 6, 2026 cell"));
      expect(screen.queryByRole("tooltip")).toBeNull();
      await userEvent.click(screen.getByLabelText("Oct 5, 2026 cell"));
      expect(screen.getByRole("tooltip")).toHaveTextContent("Job Added: 4");
      await userEvent.click(document.body);
      expect(screen.queryByRole("tooltip")).toBeNull();
    });
  });
});
