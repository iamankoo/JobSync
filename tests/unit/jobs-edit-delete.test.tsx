// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JobsBrowser } from "@/components/jobs/jobs-browser";
import { jsonResponse, makeJobs, TODAY, TZ } from "../helpers/fixtures";

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const setup = (props: Partial<React.ComponentProps<typeof JobsBrowser>> = {}) =>
  render(<JobsBrowser jobs={makeJobs(1)} currentMemberId="anni" timeZone={TZ} today={TODAY} {...props} />);

const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

async function openMenu(user: ReturnType<typeof userEvent.setup>, title: string, item: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`More actions: ${title}`) }));
  await user.click(screen.getByRole("menuitem", { name: item }));
}

describe("All Jobs: edit and delete (owner only)", () => {
  it("offers Edit/Delete only on jobs the signed-in member added", async () => {
    const user = userEvent.setup();
    const jobs = [...makeJobs(1), { ...makeJobs(2)[1], addedBy: "lukky" as const }];
    setup({ jobs });
    await user.click(screen.getByRole("button", { name: /More actions: Test Role 1/ }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toContain("Edit job");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /More actions: Test Role 2/ }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["View details", "Mark as applied"]);
  });

  it("edits a job: pre-filled form, sends editable fields only, and updates the row from the server's response", async () => {
    const user = userEvent.setup();
    const { myStatus: _s, ...saved } = { ...makeJobs(1)[0], jobRole: "Corrected Title" };
    void _s;
    fetchMock.mockResolvedValue(jsonResponse({ data: saved }));
    setup();
    await openMenu(user, "Test Role 1", "Edit job");

    const dialog = screen.getByRole("dialog", { name: "Edit job" });
    const title = within(dialog).getByLabelText(/^Job Title/);
    expect(title).toHaveValue("Test Role 1");
    expect(within(dialog).getByLabelText(/^Company/)).toHaveValue("Synthetic Co 1");
    await user.clear(title);
    await user.type(title, "Corrected Title");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/jobs/job_1");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body);
    expect(body.jobRole).toBe("Corrected Title");
    for (const forbidden of ["addedBy", "memberId", "jobId", "addedAt"]) expect(body).not.toHaveProperty(forbidden);

    expect(await screen.findByRole("status")).toHaveTextContent(/Saved changes to "Corrected Title at Synthetic Co 1"/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Corrected Title" })).toBeInTheDocument();
    // the member's own application status is untouched by an edit
    expect(screen.getByRole("button", { name: /Corrected Title at Synthetic Co 1: Not applied/ })).toBeInTheDocument();
  });

  it("validates the edit form locally and shows a server rejection without closing the dialog", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "not_job_owner", message: "Only the member who added this job can edit or delete it." } }, 403));
    setup();
    await openMenu(user, "Test Role 1", "Edit job");
    const dialog = screen.getByRole("dialog", { name: "Edit job" });
    await user.clear(within(dialog).getByLabelText(/^Job Title/));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(within(dialog).getByText("This field is required")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/^Job Title/), "Another");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Only the member who added this job");
    expect(screen.getByRole("dialog", { name: "Edit job" })).toBeInTheDocument();
  });

  it("surfaces a duplicate link when editing", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: "duplicate_url", message: "dup", details: { existingJobId: "job_9", company: "Synthetic Co 9", jobRole: "Test Role 9" } } }, 409),
    );
    setup();
    await openMenu(user, "Test Role 1", "Edit job");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Already added/)).toBeInTheDocument();
  });

  it("Cancel closes the edit dialog without calling the server", async () => {
    const user = userEvent.setup();
    setup();
    await openMenu(user, "Test Role 1", "Edit job");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes only after confirmation, then removes the job from the list", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ data: { jobId: "job_1" } }));
    setup({ jobs: makeJobs(2) });
    await openMenu(user, "Test Role 1", "Delete job");

    const dialog = screen.getByRole("dialog", { name: "Delete this job?" });
    expect(dialog).toHaveTextContent(/permanently removed for everyone/);
    expect(fetchMock).not.toHaveBeenCalled(); // nothing happens until confirmed
    await user.click(within(dialog).getByRole("button", { name: "Delete job" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/jobs/job_1");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
    expect(await screen.findByRole("status")).toHaveTextContent(/Deleted "Test Role 1 at Synthetic Co 1"/);
    expect(bodyRows()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Test Role 1" })).not.toBeInTheDocument();
  });

  it("cancelling the confirmation keeps the job; a server error keeps it too", async () => {
    const user = userEvent.setup();
    setup();
    await openMenu(user, "Test Role 1", "Delete job");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bodyRows()).toHaveLength(1);

    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "data_service_unavailable", message: "The data service is busy. Please try again shortly." } }, 503));
    await openMenu(user, "Test Role 1", "Delete job");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete job" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The data service is busy");
    expect(bodyRows()).toHaveLength(1);
  });

  it("treats 'already deleted' (404) as done", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: "job_not_found", message: "That job does not exist." } }, 404));
    setup({ jobs: makeJobs(2) });
    await openMenu(user, "Test Role 1", "Delete job");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete job" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Deleted/);
    expect(bodyRows()).toHaveLength(1);
  });

  it("owner can edit and delete from the details dialog too", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Test Role 1" }));
    const dialog = screen.getByRole("dialog", { name: "Job details" });
    expect(within(dialog).getByRole("button", { name: /Edit/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Delete/ }));
    expect(screen.getByRole("dialog", { name: "Delete this job?" })).toBeInTheDocument();
  });

  it("non-owners see no Edit/Delete in the details dialog", async () => {
    const user = userEvent.setup();
    setup({ currentMemberId: "lukky" });
    await user.click(screen.getByRole("button", { name: "Test Role 1" }));
    const dialog = screen.getByRole("dialog", { name: "Job details" });
    expect(within(dialog).queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  });
});

describe("All Jobs: live refresh", () => {
  it("shows jobs added, edited or deleted by other members when fresh data arrives", () => {
    const view = render(<JobsBrowser jobs={makeJobs(2)} currentMemberId="anni" timeZone={TZ} today={TODAY} />);
    expect(bodyRows()).toHaveLength(2);
    view.rerender(<JobsBrowser jobs={makeJobs(3)} currentMemberId="anni" timeZone={TZ} today={TODAY} />);
    expect(bodyRows()).toHaveLength(3);
    const edited = makeJobs(3).map((j) => (j.jobId === "job_2" ? { ...j, jobRole: "Edited elsewhere" } : j));
    view.rerender(<JobsBrowser jobs={edited} currentMemberId="anni" timeZone={TZ} today={TODAY} />);
    expect(screen.getByRole("button", { name: "Edited elsewhere" })).toBeInTheDocument();
    view.rerender(<JobsBrowser jobs={makeJobs(1)} currentMemberId="anni" timeZone={TZ} today={TODAY} />);
    expect(bodyRows()).toHaveLength(1);
  });

  it("closes an open details dialog if that job was deleted by someone else", async () => {
    const user = userEvent.setup();
    const view = render(<JobsBrowser jobs={makeJobs(2)} currentMemberId="anni" timeZone={TZ} today={TODAY} />);
    await user.click(screen.getByRole("button", { name: "Test Role 2" }));
    expect(screen.getByRole("dialog", { name: "Job details" })).toBeInTheDocument();
    view.rerender(<JobsBrowser jobs={makeJobs(1)} currentMemberId="anni" timeZone={TZ} today={TODAY} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
