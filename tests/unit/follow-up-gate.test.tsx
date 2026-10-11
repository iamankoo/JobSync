// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));

import { FollowUpGate, type DueFollowUpItem } from "@/components/follow-up/follow-up-gate";
import { jsonResponse } from "../helpers/fixtures";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  refresh.mockReset();
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const item = (n: number): DueFollowUpItem => ({ jobId: `job_${n}`, company: `Synthetic Co ${n}`, jobRole: `Test Role ${n}`, appliedAt: "2026-10-01T10:00:00.000Z" });
const ok = (answer: string) => jsonResponse({ data: { jobId: "x", answer, changed: true } });
const setup = (items = [item(1)]) => render(<FollowUpGate items={items} timeZone="Asia/Kolkata" />);
const dialog = () => screen.getByRole("alertdialog");

describe("follow-up modal", () => {
  it("shows nothing when no follow-up is due", () => {
    setup([]);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("asks the status question with the real company, role and application date, and the four exact choices", () => {
    setup();
    expect(screen.getByRole("heading", { name: "What's the current status of this application?" })).toBeInTheDocument();
    const d = within(dialog());
    expect(d.getByText("Test Role 1")).toBeInTheDocument();
    expect(d.getByText("Synthetic Co 1")).toBeInTheDocument();
    expect(d.getByText("Applied on 01 Oct 2026")).toBeInTheDocument();
    expect(d.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Yes, I've been shortlisted", "I've received an interview call", "I've received an offer", "No update yet",
    ]);
    expect(dialog()).toHaveAccessibleName("What's the current status of this application?");
  });

  it("cannot be dismissed: no close button, Escape does nothing, a backdrop click does nothing", async () => {
    const user = userEvent.setup();
    setup();
    expect(within(dialog()).queryByRole("button", { name: /close|dismiss|cancel/i })).not.toBeInTheDocument();
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog(), cancel); // what Escape triggers on a native dialog
    expect(cancel.defaultPrevented).toBe(true);
    await user.keyboard("{Escape}");
    await user.click(dialog()); // click on the dialog element itself (the backdrop area)
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("focuses the first choice so the keyboard can answer immediately", () => {
    setup();
    expect(within(dialog()).getByRole("button", { name: "Yes, I've been shortlisted" })).toHaveFocus();
  });

  it.each([
    ["Yes, I've been shortlisted", "Shortlisted"],
    ["I've received an interview call", "Interview"],
    ["I've received an offer", "Offer"],
    ["No update yet", "No update"],
  ])("choosing '%s' saves %s through the server and then closes the (only) question", async (label, answer) => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(ok(answer));
    setup();
    await user.click(within(dialog()).getByRole("button", { name: label }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/follow-ups/job_1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ answer }); // only the answer: no member, timestamp or stage
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(refresh).toHaveBeenCalledTimes(1); // so every count and status re-reads the saved data
  });

  it("asks several due jobs one at a time, in order, saving each before the next appears", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => Promise.resolve(ok("No update"))); // a fresh Response per call
    setup([item(1), item(2), item(3)]);
    expect(screen.getByText("Question 1 of 3")).toBeInTheDocument();
    expect(within(dialog()).getByText("Test Role 1")).toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "No update yet" }));
    await screen.findByText("Question 2 of 3");
    expect(within(dialog()).getByText("Test Role 2")).toBeInTheDocument();
    await user.click(within(dialog()).getByRole("button", { name: "I've received an offer" }));
    await screen.findByText("Question 3 of 3");
    await user.click(within(dialog()).getByRole("button", { name: "No update yet" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/follow-ups/job_1", "/api/follow-ups/job_2", "/api/follow-ups/job_3"]);
  });

  it("while saving, every choice is disabled so a double tap cannot submit twice", async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
    setup();
    await user.click(within(dialog()).getByRole("button", { name: "Yes, I've been shortlisted" }));
    for (const b of within(dialog()).getAllByRole("button")) expect(b).toBeDisabled();
    await user.click(within(dialog()).getByRole("button", { name: "No update yet" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => release(ok("Shortlisted")));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("if saving fails the question stays open with a clear message and can be retried; nothing advances", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "data_service_unavailable", message: "The data service is busy. Please try again shortly." } }, 503));
    setup([item(1), item(2)]);
    await user.click(within(dialog()).getByRole("button", { name: "Yes, I've been shortlisted" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("The data service is busy");
    expect(within(dialog()).getByText("Test Role 1")).toBeInTheDocument(); // still the first question
    expect(screen.getByText("Question 1 of 2")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    for (const b of within(dialog()).getAllByRole("button")) expect(b).toBeEnabled();

    fetchMock.mockResolvedValueOnce(ok("Shortlisted"));
    await user.click(within(dialog()).getByRole("button", { name: "Yes, I've been shortlisted" }));
    await screen.findByText("Question 2 of 2");
    expect(within(dialog()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a network failure also keeps the question open", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    setup();
    await user.click(within(dialog()).getByRole("button", { name: "I've received an offer" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(/Network error/);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("moves on if the question was already answered elsewhere or no longer applies", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "follow_up_conflict", message: "already answered" } }, 409));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: "follow_up_not_applicable", message: "no longer applies" } }, 409));
    setup([item(1), item(2)]);
    await user.click(within(dialog()).getByRole("button", { name: "No update yet" }));
    await screen.findByText("Question 2 of 2");
    await user.click(within(dialog()).getByRole("button", { name: "No update yet" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("a question that becomes due while the page is open appears after the next data refresh", () => {
    const view = render(<FollowUpGate items={[]} timeZone="Asia/Kolkata" />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    view.rerender(<FollowUpGate items={[item(7)]} timeZone="Asia/Kolkata" />);
    expect(within(dialog()).getByText("Test Role 7")).toBeInTheDocument();
  });

  it("never re-shows a question just answered while the refreshed data is still arriving", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(ok("No update"));
    const view = render(<FollowUpGate items={[item(1)]} timeZone="Asia/Kolkata" />);
    await user.click(within(dialog()).getByRole("button", { name: "No update yet" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    view.rerender(<FollowUpGate items={[item(1)]} timeZone="Asia/Kolkata" />); // stale props still list it
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
