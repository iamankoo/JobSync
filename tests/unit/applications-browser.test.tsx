// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApplicationsBrowser } from "@/components/applications/applications-browser";
import { jsonResponse, makeApplication, makeRows, TODAY, TZ } from "../helpers/fixtures";

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const setup = (rows = makeRows([[1, "Applied"], [2, "In Progress"], [3, "Offer"]]), extra: Partial<React.ComponentProps<typeof ApplicationsBrowser>> = {}) =>
  render(<ApplicationsBrowser rows={rows} timeZone={TZ} today={TODAY} {...extra} />);

const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
const rowFor = (title: string) => bodyRows().find((r) => within(r).queryByRole("button", { name: title }))!;

async function openUpdate(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`More actions: ${title}`) }));
  await user.click(screen.getByRole("menuitem", { name: "Update status" }));
  return screen.getByRole("dialog", { name: "Update application" });
}

describe("My Applications: table", () => {
  it("lists exactly the rows it is given with the required columns, and has no charts", () => {
    setup();
    expect(screen.getByRole("heading", { name: "My Applications" })).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(3);
    const headers = within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent?.replace(/: sort.*/, "").trim());
    expect(headers).toEqual(["#", "Job Title", "Company", "Location", "Type", "Experience", "Stipend / Salary", "Status", "Applied On", "Deadline", "Actions"]);
    expect(within(rowFor("Test Role 1")).getByText("Applied")).toBeInTheDocument();
    expect(within(rowFor("Test Role 3")).getByText("Offer")).toBeInTheDocument();
    expect(document.querySelector("canvas, svg[role='img'], [data-chart]")).toBeNull();
  });

  it("shows a designed empty state that points to All Jobs when there are no applications", () => {
    setup([]);
    expect(screen.getByRole("heading", { name: "No applications yet" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse All Jobs" })).toHaveAttribute("href", "/all-jobs");
  });

  it("offers status filters limited to applied-stage statuses, and filters/searches/resets", async () => {
    const user = userEvent.setup();
    setup(makeRows([[1, "Applied"], [2, "In Progress"], [3, "Applied"], [4, "Interview"]]));
    expect(within(screen.getByLabelText("Status")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Status", "Applied", "In Progress", "Interview", "Offer", "Rejected"]);

    await user.selectOptions(screen.getByLabelText("Status"), "Applied");
    expect(bodyRows()).toHaveLength(2); // exactly "Applied", not "any applied"
    await user.selectOptions(screen.getByLabelText("Status"), "Interview");
    expect(bodyRows()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(bodyRows()).toHaveLength(4);

    await user.type(screen.getByRole("searchbox", { name: "Search your applications" }), "role 4");
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText(/Showing 1–1 of 1 application \(filtered from 4\)/)).toBeInTheDocument();
  });

  it("paginates long lists", async () => {
    const user = userEvent.setup();
    setup(makeRows(Array.from({ length: 12 }, (_, i) => [i + 1, "Applied"] as [number, "Applied"])));
    expect(bodyRows()).toHaveLength(10);
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(bodyRows()).toHaveLength(2);
    expect(screen.getByText("Showing 11–12 of 12 applications")).toBeInTheDocument();
  });

  it("notes hidden applications whose job no longer exists", () => {
    setup(makeRows([[1, "Applied"]]), { skipped: 1 });
    expect(screen.getByText(/1 application was hidden/)).toBeInTheDocument();
  });
});

describe("My Applications: updating status", () => {
  it("offers only the transitions the server allows from the current status", async () => {
    const user = userEvent.setup();
    setup(makeRows([[1, "Applied"], [3, "Offer"]]));
    let dialog = await openUpdate(user, "Test Role 1");
    expect(within(within(dialog).getByLabelText("Status")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Applied", "Not Applied", "In Progress", "Interview", "Offer", "Rejected",
    ]);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    dialog = await openUpdate(user, "Test Role 3");
    expect(within(within(dialog).getByLabelText("Status")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Offer", "Rejected"]);
  });

  it("saves status, stage and notes for the signed-in member only (no member ID sent) and updates the row", async () => {
    const user = userEvent.setup();
    const updated = makeApplication(1, "Interview", { applicationStage: "HR Interview", notes: "went well" });
    fetchMock.mockResolvedValue(jsonResponse({ data: { jobId: "job_1", status: "Interview", application: updated, changed: true } }));
    setup(makeRows([[1, "Applied"], [2, "Applied"]]));

    const dialog = await openUpdate(user, "Test Role 1");
    await user.selectOptions(within(dialog).getByLabelText("Status"), "Interview");
    await user.selectOptions(within(dialog).getByLabelText(/^Stage/), "HR Interview");
    await user.type(within(dialog).getByLabelText(/^Notes/), "went well");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/applications/job_1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ status: "Interview", applicationStage: "HR Interview", notes: "went well" });
    expect(JSON.parse(init.body)).not.toHaveProperty("memberId");

    expect(await screen.findByRole("status")).toHaveTextContent(/Updated "Test Role 1 at Synthetic Co 1": Interview/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(rowFor("Test Role 1")).getByText("HR Interview")).toBeInTheDocument();
    expect(within(rowFor("Test Role 1")).getByText("Interview")).toBeInTheDocument();
    // the other application is untouched
    expect(within(rowFor("Test Role 2")).getByText("Applied")).toBeInTheDocument();
  });

  it("moving back to Not Applied warns, removes the row, and shows the empty state when it was the last one", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ data: { jobId: "job_1", status: "Not Applied", application: makeApplication(1, "Not Applied"), changed: true } }));
    setup(makeRows([[1, "Applied"]]));
    const dialog = await openUpdate(user, "Test Role 1");
    await user.selectOptions(within(dialog).getByLabelText("Status"), "Not Applied");
    expect(within(dialog).getByText(/removes it from My Applications/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Stage/)).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ status: "Not Applied", applicationStage: null, notes: null });
    expect(await screen.findByRole("heading", { name: "No applications yet" })).toBeInTheDocument();
  });

  it("keeps the dialog open and shows the server's message when saving fails", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "invalid_transition", message: 'Cannot change status from "Applied" to "Offer".' } }, 409));
    setup(makeRows([[1, "Applied"]]));
    const dialog = await openUpdate(user, "Test Role 1");
    await user.selectOptions(within(dialog).getByLabelText("Status"), "Offer");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Cannot change status");
    expect(screen.getByRole("dialog", { name: "Update application" })).toBeInTheDocument();
  });

  it("View details opens the job's full details read-only for this member", async () => {
    const user = userEvent.setup();
    setup(makeRows([[1, "Applied"]]));
    await user.click(screen.getByRole("button", { name: /More actions: Test Role 1/ }));
    await user.click(screen.getByRole("menuitem", { name: "View details" }));
    const dialog = screen.getByRole("dialog", { name: "Job details" });
    expect(within(dialog).getByText("Synthetic description 1")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Mark as/ })).not.toBeInTheDocument();
  });
});
