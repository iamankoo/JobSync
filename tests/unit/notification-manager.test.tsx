// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/push/browser", async (orig) => ({ ...(await orig<typeof import("@/lib/push/browser")>()), ensureSubscribed: vi.fn(), pushAvailable: vi.fn() }));

import { ensureSubscribed, pushAvailable } from "@/lib/push/browser";
import { NotificationManager } from "@/components/notifications/notification-manager";

type Perm = "default" | "granted" | "denied";
let requestPermission: ReturnType<typeof vi.fn>;

function setBrowser(permission: Perm | "unsupported", requestResult: Perm = "granted") {
  requestPermission = vi.fn(async () => requestResult);
  if (permission === "unsupported") {
    vi.stubGlobal("Notification", undefined);
    delete (window as unknown as Record<string, unknown>).Notification;
    return;
  }
  const N = Object.assign(function Notification() {}, { permission, requestPermission });
  vi.stubGlobal("Notification", N);
  Object.defineProperty(window, "Notification", { value: N, configurable: true, writable: true });
  Object.defineProperty(navigator, "serviceWorker", {
    value: { addEventListener: vi.fn(), removeEventListener: vi.fn() }, configurable: true,
  });
  Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true, writable: true });
}

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(ensureSubscribed).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(pushAvailable).mockReset().mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).PushManager;
});

const dialog = () => screen.queryByTestId("notification-onboarding");

describe("NotificationManager", () => {
  it("default: shows the onboarding dialog with the required message and does NOT prompt automatically", async () => {
    setBrowser("default");
    render(<NotificationManager memberId="anni" showOnboarding />);
    expect(await screen.findByText(/Enable notifications to know immediately when Anni, Lukky, or Rishii adds a job or applies for one\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable Notifications" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(ensureSubscribed).not.toHaveBeenCalled();
  });

  it("only requests permission after a deliberate click, then registers and closes for good", async () => {
    setBrowser("default", "granted");
    render(<NotificationManager memberId="anni" showOnboarding />);
    await userEvent.click(await screen.findByRole("button", { name: "Enable Notifications" }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(ensureSubscribed).toHaveBeenCalledWith("anni");
  });

  it("choosing 'Block' in the browser prompt switches to the denied instructions without re-prompting", async () => {
    setBrowser("default", "denied");
    render(<NotificationManager memberId="anni" showOnboarding />);
    await userEvent.click(await screen.findByRole("button", { name: "Enable Notifications" }));
    expect(await screen.findByText(/Chrome has blocked notifications/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable Notifications" })).toBeNull();
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("denied: explains how to enable notifications in Chrome and never calls the native prompt", async () => {
    setBrowser("denied");
    render(<NotificationManager memberId="anni" showOnboarding />);
    expect(await screen.findByText(/Chrome has blocked notifications/)).toBeInTheDocument();
    expect(screen.getAllByText(/Site settings/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("denied: 'Check again' registers once the member has allowed notifications in Chrome settings", async () => {
    setBrowser("denied");
    render(<NotificationManager memberId="anni" showOnboarding />);
    const check = await screen.findByRole("button", { name: "Check again" });
    (Notification as unknown as { permission: Perm }).permission = "granted";
    await userEvent.click(check);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(ensureSubscribed).toHaveBeenCalledWith("anni");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("granted: registers silently, shows no dialog", async () => {
    setBrowser("granted");
    render(<NotificationManager memberId="lukky" showOnboarding />);
    await waitFor(() => expect(ensureSubscribed).toHaveBeenCalledWith("lukky"));
    expect(dialog()).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("granted but registration fails: offers a clear way to retry", async () => {
    setBrowser("granted");
    vi.mocked(ensureSubscribed).mockResolvedValueOnce({ ok: false, reason: "failed" });
    render(<NotificationManager memberId="anni" showOnboarding />);
    expect(await screen.findByText(/couldn’t finish setting them up/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("push not configured on the server: stays quiet", async () => {
    setBrowser("granted");
    vi.mocked(ensureSubscribed).mockResolvedValue({ ok: false, reason: "unconfigured" });
    render(<NotificationManager memberId="anni" showOnboarding />);
    await waitFor(() => expect(ensureSubscribed).toHaveBeenCalled());
    expect(dialog()).toBeNull();
  });

  it("default but push is not set up on the server: members are not invited to enable anything", async () => {
    setBrowser("default");
    vi.mocked(pushAvailable).mockResolvedValue(false);
    render(<NotificationManager memberId="anni" showOnboarding />);
    await waitFor(() => expect(pushAvailable).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(dialog()).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("unsupported browser: explains push is unavailable and offers no enable button", async () => {
    setBrowser("unsupported");
    render(<NotificationManager memberId="anni" showOnboarding />);
    expect(await screen.findByText(/doesn’t support push notifications/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable Notifications" })).toBeNull();
  });

  it("does not trap the member: 'Not now' closes it and it stays closed for the browser session", async () => {
    setBrowser("default");
    const { unmount } = render(<NotificationManager memberId="anni" showOnboarding />);
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(dialog()).toBeNull();
    unmount();
    render(<NotificationManager memberId="anni" showOnboarding />); // e.g. back on the Dashboard
    await new Promise((r) => setTimeout(r, 20));
    expect(dialog()).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("the close (X) button also dismisses it", async () => {
    setBrowser("default");
    render(<NotificationManager memberId="anni" showOnboarding />);
    await userEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(dialog()).toBeNull();
  });

  it("a dismissed prompt for the native dialog (no choice) keeps the dialog usable", async () => {
    setBrowser("default", "default");
    render(<NotificationManager memberId="anni" showOnboarding />);
    await userEvent.click(await screen.findByRole("button", { name: "Enable Notifications" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/No choice was made/);
    expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
  });

  it("is dismissed per member and only shows on the Dashboard", async () => {
    setBrowser("default");
    const { rerender } = render(<NotificationManager memberId="anni" showOnboarding={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(dialog()).toBeNull();
    rerender(<NotificationManager memberId="anni" showOnboarding />);
    expect(await screen.findByTestId("notification-onboarding")).toBeInTheDocument();
  });
});
