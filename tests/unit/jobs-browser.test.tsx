// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JobsBrowser } from "@/components/jobs/jobs-browser";
import { jsonResponse, makeApplication, makeJobs, TODAY, TZ } from "../helpers/fixtures";

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const setup = (props: Partial<React.ComponentProps<typeof JobsBrowser>> = {}) =>
  render(<JobsBrowser jobs={makeJobs(3)} currentMemberId="anni" timeZone={TZ} today={TODAY} {...props} />);

const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("All Jobs: data and empty states", () => {
  it("renders the shared jobs it is given, with summary counts derived from the member's statuses", () => {
    setup({ jobs: makeJobs(4, { 1: "Applied", 2: "Interview", 3: "Rejected" }) });
    expect(screen.getByRole("heading", { name: "All Jobs" })).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(4);
    const summary = within(screen.getByRole("region", { name: "Your job summary" }));
    expect(summary.getByText("Total Jobs").previousElementSibling).toHaveTextContent("4");
    expect(summary.getByText("Applied").previousElementSibling).toHaveTextContent("3");
    expect(summary.getByText("Pending").previousElementSibling).toHaveTextContent("2");
    expect(summary.getByText("Not Applied").previousElementSibling).toHaveTextContent("1");
  });

  it("shows a designed empty state with a working add-job link, and zero counts, when there are no jobs", () => {
    setup({ jobs: [] });
    expect(screen.getByRole("heading", { name: "No jobs yet" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    // Same "Add New Job" label in the header and in the empty state, both pointing to the form.
    const addLinks = screen.getAllByRole("link", { name: /Add New Job/ });
    expect(addLinks).toHaveLength(2);
    for (const link of addLinks) expect(link).toHaveAttribute("href", "/add-job");
    const summary = within(screen.getByRole("region", { name: "Your job summary" }));
    expect(summary.getByText("Total Jobs").previousElementSibling).toHaveTextContent("0");
  });

  it("reports skipped spreadsheet rows without showing their contents", () => {
    setup({ skippedRows: 2 });
    expect(screen.getByText(/2 spreadsheet rows were skipped/)).toBeInTheDocument();
  });

  it("shows only dropdown options that exist in the real data", () => {
    setup({ jobs: makeJobs(4) });
    const company = screen.getByLabelText("Company");
    expect(within(company).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Company", "Synthetic Co 1", "Synthetic Co 2", "Synthetic Co 3", "Synthetic Co 4",
    ]);
    expect(within(screen.getByLabelText("Job Type")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Job Type", "Full-time", "Internship"]);
  });

  it("each row links to the external job posting safely", () => {
    setup({ jobs: makeJobs(1) });
    const link = screen.getByRole("link", { name: /Open job posting: Test Role 1 at Synthetic Co 1/ });
    expect(link).toHaveAttribute("href", "https://jobs.example.test/1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });
});

describe("All Jobs: search, filters, sorting, pagination", () => {
  it("search narrows the list and updates the summary; no match shows an empty state that Reset clears", async () => {
    const user = userEvent.setup();
    setup({ jobs: makeJobs(5) });
    await user.type(screen.getByRole("searchbox", { name: "Search jobs" }), "role 4");
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText(/Showing 1–1 of 1 job \(filtered from 5\)/)).toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox", { name: "Search jobs" }));
    await user.type(screen.getByRole("searchbox", { name: "Search jobs" }), "nothing-matches-this");
    expect(screen.getByRole("heading", { name: "No jobs match your search" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(bodyRows()).toHaveLength(5);
  });

  it("is prefilled from the global search (initialQuery)", () => {
    setup({ jobs: makeJobs(5), initialQuery: "role 2" });
    expect(screen.getByRole("searchbox", { name: "Search jobs" })).toHaveValue("role 2");
    expect(bodyRows()).toHaveLength(1);
  });

  it("filters by dropdowns, combines them, and Reset restores everything", async () => {
    const user = userEvent.setup();
    setup({ jobs: makeJobs(6, { 1: "Applied", 2: "Applied" }) });
    const reset = screen.getByRole("button", { name: "Reset" });
    expect(reset).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Job Type"), "Internship");
    expect(bodyRows()).toHaveLength(3); // jobs 2, 4, 6
    expect(reset).toBeEnabled();
    await user.selectOptions(screen.getByLabelText("Status"), "Applied");
    expect(bodyRows()).toHaveLength(1); // only job 2 is an applied internship
    expect(within(bodyRows()[0]).getByText("Test Role 2")).toBeInTheDocument();

    await user.click(reset);
    expect(bodyRows()).toHaveLength(6);
    expect(screen.getByLabelText("Job Type")).toHaveValue("");
    expect(reset).toBeDisabled();
  });

  it("paginates 10 per page with working next/previous/number controls, and filtering returns to page 1", async () => {
    const user = userEvent.setup();
    setup({ jobs: makeJobs(25) });
    expect(bodyRows()).toHaveLength(10);
    expect(screen.getByText("Showing 1–10 of 25 jobs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Showing 11–20 of 25 jobs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "Page 3" }));
    expect(bodyRows()).toHaveLength(5);
    expect(screen.getByText("Showing 21–25 of 25 jobs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Job Type"), "Internship");
    expect(screen.getByText(/Showing 1–10 of 12 jobs/)).toBeInTheDocument();
  });

  it("hides pagination controls when everything fits on one page", () => {
    setup({ jobs: makeJobs(3) });
    expect(screen.queryByRole("navigation", { name: "Pagination" })).not.toBeInTheDocument();
  });

  it("sorts by deadline (soonest first, then reversed) and by added date", async () => {
    const user = userEvent.setup();
    setup({ jobs: makeJobs(3) });
    const titles = () => bodyRows().map((r) => within(r).getAllByRole("cell")[1].textContent);
    const initial = titles();
    expect(initial).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: /Deadline/ }));
    expect(screen.getByRole("columnheader", { name: /Deadline/ })).toHaveAttribute("aria-sort", "ascending");
    expect(titles()).toEqual(["Test Role 1", "Test Role 2", "Test Role 3"]);
    await user.click(screen.getByRole("button", { name: /Deadline/ }));
    expect(titles()).toEqual(["Test Role 3", "Test Role 2", "Test Role 1"]);
  });
});

describe("All Jobs: personal status control", () => {
  it("marks a job as applied via the server route, sending only the status (never a member ID), and updates counts", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ data: { jobId: "job_1", status: "Applied", application: makeApplication(1, "Applied"), changed: true } }));
    setup({ jobs: makeJobs(2) });

    await user.click(screen.getByRole("button", { name: /Test Role 1 at Synthetic Co 1: Not applied\. Mark as applied/ }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/applications/job_1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ status: "Applied" });

    expect(await screen.findByRole("button", { name: /Test Role 1 at Synthetic Co 1: Applied\. Mark as not applied/ })).toBeInTheDocument();
    // the other job is untouched
    expect(screen.getByRole("button", { name: /Test Role 2 at Synthetic Co 2: Not applied/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/marked as Applied/);
    const summary = within(screen.getByRole("region", { name: "Your job summary" }));
    expect(summary.getByText("Not Applied").previousElementSibling).toHaveTextContent("1");
  });

  it("can undo: Applied goes back to Not Applied", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ data: { jobId: "job_1", status: "Not Applied", application: null, changed: true } }));
    setup({ jobs: makeJobs(1, { 1: "Applied" }) });
    await user.click(screen.getByRole("button", { name: /Applied\. Mark as not applied/ }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ status: "Not Applied" });
    expect(await screen.findByRole("button", { name: /Not applied\. Mark as applied/ })).toBeInTheDocument();
  });

  it("keeps the old status and shows the server's message when the update fails", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "data_service_unavailable", message: "The data service is busy. Please try again shortly." } }, 503));
    setup({ jobs: makeJobs(1) });
    await user.click(screen.getByRole("button", { name: /Mark as applied/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The data service is busy");
    expect(screen.getByRole("button", { name: /Not applied\. Mark as applied/ })).toBeInTheDocument();
  });

  it("handles a network failure gracefully", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    setup({ jobs: makeJobs(1) });
    await user.click(screen.getByRole("button", { name: /Mark as applied/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Network error/);
  });

  it("shows later stages with the tick but locks the toggle (managed in My Applications)", () => {
    setup({ jobs: makeJobs(1, { 1: "Interview" }) });
    const toggle = screen.getByRole("button", { name: /Interview\. Manage this in My Applications/ });
    expect(toggle).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the row actions menu offers View details and a status action", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ data: { jobId: "job_1", status: "Applied", application: makeApplication(1, "Applied"), changed: true } }));
    setup({ jobs: makeJobs(1) });
    await user.click(screen.getByRole("button", { name: /More actions: Test Role 1/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["View details", "Mark as applied", "Edit job", "Delete job"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Mark as applied" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("All Jobs: details dialog", () => {
  it("opens from the title with all real fields and closes again", async () => {
    const user = userEvent.setup();
    setup({ jobs: makeJobs(1) });
    await user.click(screen.getByRole("button", { name: "Test Role 1" }));
    const dialog = screen.getByRole("dialog", { name: "Job details" });
    expect(within(dialog).getByText("Synthetic description 1")).toBeInTheDocument();
    expect(within(dialog).getByText("Test pay 1")).toBeInTheDocument();
    expect(within(dialog).getByText("1–3 years")).toBeInTheDocument();
    expect(within(dialog).getByText(/Anni on/)).toBeInTheDocument();
    const open = within(dialog).getByRole("link", { name: /Open job posting/ });
    expect(open).toHaveAttribute("href", "https://jobs.example.test/1");
    expect(open).toHaveAttribute("target", "_blank");

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("can change the member's own status from inside the dialog", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ data: { jobId: "job_1", status: "Applied", application: makeApplication(1, "Applied"), changed: true } }));
    setup({ jobs: makeJobs(1) });
    await user.click(screen.getByRole("button", { name: "Test Role 1" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Mark as applied/ }));
    expect(await within(dialog).findByRole("button", { name: /Applied\. Mark as not applied/ })).toBeInTheDocument();
  });
});
