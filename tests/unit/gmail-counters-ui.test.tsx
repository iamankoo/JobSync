// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();
vi.mock("@/lib/client/api", () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

import { COUNTER_POLL_MS, GmailConnect } from "@/components/gmail/gmail-connect";
import type { DraftList } from "@/lib/gmail/draft-list";

const members = [{ id: "anni" as const, connected: true }, { id: "lukky" as const, connected: true }, { id: "rishii" as const, connected: false }];
const list = (drafted: number, sent: number): DraftList => ({ setUp: true, drafted, sent, items: [] });

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}
const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ ok: true, data: { drafted: 0, sent: 0, memberId: "anni" } });
  setVisibility("visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Draft and Sent counters", () => {
  it("shows Draft first and Sent directly to its right, in the same card style", async () => {
    apiRequest.mockResolvedValue({ ok: true, data: { drafted: 3, sent: 2, memberId: "anni" } });
    render(<GmailConnect members={members} drafts={list(3, 2)} justConnected={false} />);
    await flush();
    const draft = screen.getByTestId("gmail-count-draft");
    const sent = screen.getByTestId("gmail-count-sent");
    expect(draft.compareDocumentPosition(sent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // Sent comes after Draft
    expect(draft.nextElementSibling).toBe(sent); // directly to its right, no element between them
    expect(draft.parentElement).toBe(sent.parentElement);
    expect(sent.className).toBe(draft.className); // identical size, spacing and style
    expect(draft).toHaveTextContent("Draft");
    expect(sent).toHaveTextContent("Sent");
    expect(draft.querySelector("[aria-label='3 draft']")).not.toBeNull();
    expect(sent.querySelector("[aria-label='2 sent']")).not.toBeNull();
    expect(screen.getByRole("group", { name: "Draft and sent counts" })).toContainElement(sent);
  });

  it("asks the server as soon as the page loads (that call also reconciles with Gmail) and shows the fresh values", async () => {
    apiRequest.mockResolvedValue({ ok: true, data: { drafted: 1, sent: 4, memberId: "anni" } });
    render(<GmailConnect members={members} drafts={list(5, 0)} justConnected={false} />);
    expect(screen.getByTestId("gmail-count-sent")).toHaveTextContent("0"); // server-rendered value first
    await flush();
    expect(apiRequest).toHaveBeenCalledWith("/api/gmail/counters");
    expect(screen.getByTestId("gmail-count-draft")).toHaveTextContent("1");
    expect(screen.getByTestId("gmail-count-sent")).toHaveTextContent("4");
  });

  it("updates by itself every 15 s while visible, without a page refresh", async () => {
    render(<GmailConnect members={members} drafts={list(2, 0)} justConnected={false} />);
    await flush();
    expect(screen.getByTestId("gmail-count-sent")).toHaveTextContent("0");
    apiRequest.mockResolvedValue({ ok: true, data: { drafted: 1, sent: 1, memberId: "anni" } }); // a JobSync send was confirmed
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNTER_POLL_MS);
    });
    expect(screen.getByTestId("gmail-count-draft")).toHaveTextContent("1");
    expect(screen.getByTestId("gmail-count-sent")).toHaveTextContent("1");
  });

  it("does not poll while the tab is hidden, and refreshes when it becomes visible again", async () => {
    setVisibility("hidden");
    render(<GmailConnect members={members} drafts={list(2, 0)} justConnected={false} />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNTER_POLL_MS * 3);
    });
    expect(apiRequest).not.toHaveBeenCalled();
    apiRequest.mockResolvedValue({ ok: true, data: { drafted: 2, sent: 7, memberId: "anni" } });
    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("gmail-count-sent")).toHaveTextContent("7");
  });

  it("a failed poll leaves the last good numbers in place", async () => {
    apiRequest.mockResolvedValue({ ok: true, data: { drafted: 2, sent: 3, memberId: "anni" } });
    render(<GmailConnect members={members} drafts={list(2, 3)} justConnected={false} />);
    await flush();
    apiRequest.mockResolvedValue({ ok: false, status: 500, code: "x", message: "x" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNTER_POLL_MS);
    });
    expect(screen.getByTestId("gmail-count-draft")).toHaveTextContent("2");
    expect(screen.getByTestId("gmail-count-sent")).toHaveTextContent("3");
  });

  it("a newer server render (page refresh / the 30 s auto-refresh) replaces the live numbers", async () => {
    const { rerender } = render(<GmailConnect members={members} drafts={list(2, 0)} justConnected={false} />);
    await flush();
    rerender(<GmailConnect members={members} drafts={list(1, 1)} justConnected={false} />);
    expect(screen.getByTestId("gmail-count-draft")).toHaveTextContent("1");
    expect(screen.getByTestId("gmail-count-sent")).toHaveTextContent("1");
  });
});
