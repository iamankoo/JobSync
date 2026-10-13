// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/push/browser", async (orig) => ({
  ...(await orig<typeof import("@/lib/push/browser")>()),
  ensureSubscribed: vi.fn(),
  pushAvailable: vi.fn(),
  hasRegistrationHint: vi.fn(),
}));

import { ensureSubscribed, hasRegistrationHint, pushAvailable } from "@/lib/push/browser";
import { NotificationGate, REPROMPT_MS } from "@/components/notifications/notification-gate";

type Perm = "default" | "granted" | "denied";
let requestPermission: ReturnType<typeof vi.fn>;
let perm: Perm;

function setBrowser(permission: Perm | "unsupported", requestResult: Perm = "granted") {
  perm = permission === "unsupported" ? "default" : permission;
  requestPermission = vi.fn(async () => {
    perm = requestResult;
    return requestResult;
  });
  if (permission === "unsupported") {
    delete (window as unknown as Record<string, unknown>).Notification;
    delete (window as unknown as Record<string, unknown>).PushManager;
    return;
  }
  const N = Object.assign(function Notification() {}, { requestPermission });
  Object.defineProperty(N, "permission", { get: () => perm, configurable: true });
  Object.defineProperty(window, "Notification", { value: N, configurable: true, writable: true });
  Object.defineProperty(navigator, "serviceWorker", { value: { addEventListener: vi.fn(), removeEventListener: vi.fn() }, configurable: true });
  Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true, writable: true });
}

const gate = (over: Partial<React.ComponentProps<typeof NotificationGate>> = {}) => (
  <NotificationGate memberId="anni" onLogout={over.onLogout ?? vi.fn()} {...over}>
    <main data-testid="app">Secret dashboard content</main>
  </NotificationGate>
);
const app = () => screen.getByTestId("app");
const wrapper = () => app().parentElement!;
const dialog = () => screen.queryByTestId("notification-onboarding");
const isBlocked = () => wrapper().getAttribute("data-notification-gate") === "blocked";
/** Lets pending promises (permission checks, fetches) settle. */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(ensureSubscribed).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(pushAvailable).mockReset().mockResolvedValue(true);
  vi.mocked(hasRegistrationHint).mockReset().mockReturnValue(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).PushManager;
});

describe("default permission", () => {
  it("blurs and blocks the whole app and shows the onboarding dialog, without calling the native prompt", async () => {
    setBrowser("default");
    render(gate());
    await settle();
    expect(isBlocked()).toBe(true);
    expect(wrapper()).toHaveAttribute("inert");
    expect(wrapper()).toHaveAttribute("aria-hidden", "true");
    expect(wrapper().style.filter).toContain("blur");
    expect(dialog()).not.toBeNull();
    expect(screen.getByText(/Enable notifications to know immediately when Anni, Lukky, or Rishii adds a job or applies for one\./)).toBeInTheDocument();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(ensureSubscribed).not.toHaveBeenCalled();
  });

  it("Not now: the dialog disappears, the app stays blocked, and the dialog returns after 2 seconds, repeatedly", async () => {
    setBrowser("default");
    render(gate());
    await settle();
    expect(REPROMPT_MS).toBe(2000);
    for (let round = 0; round < 4; round++) {
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      expect(dialog()).toBeNull();
      expect(isBlocked()).toBe(true);
      await tick(1999);
      expect(dialog()).toBeNull();
      await tick(1);
      expect(dialog()).not.toBeNull();
      expect(isBlocked()).toBe(true);
    }
    expect(requestPermission).not.toHaveBeenCalled(); // the native API is never called by the repetition
    expect(screen.getAllByTestId("notification-onboarding")).toHaveLength(1); // never two dialogs
  });

  it("Escape counts as closing: it also comes back after 2 seconds", async () => {
    setBrowser("default");
    render(gate());
    await settle();
    fireEvent(dialog()!, new Event("cancel", { cancelable: true }));
    expect(dialog()).toBeNull();
    await tick(2000);
    expect(dialog()).not.toBeNull();
  });

  it("repeated clicks never create more than one timer or dialog", async () => {
    setBrowser("default");
    render(gate());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(vi.getTimerCount()).toBe(1);
    await tick(2000);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    fireEvent.click(screen.queryByRole("button", { name: "Not now" }) ?? document.body);
    expect(vi.getTimerCount()).toBe(1);
    await tick(2000);
    expect(screen.getAllByTestId("notification-onboarding")).toHaveLength(1);
  });

  it("Enable Notifications asks the browser exactly once, then registers and unblocks", async () => {
    setBrowser("default", "granted");
    render(gate());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Enable Notifications" }));
    await settle();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(ensureSubscribed).toHaveBeenCalledWith("anni");
    expect(isBlocked()).toBe(false);
    expect(wrapper()).not.toHaveAttribute("inert");
    expect(dialog()).toBeNull();
    await tick(10_000);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("granted permission but failed registration keeps the app blocked, explains it, and Retry registers once it works", async () => {
    setBrowser("default", "granted");
    vi.mocked(ensureSubscribed).mockResolvedValueOnce({ ok: false, reason: "failed" });
    render(gate());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Enable Notifications" }));
    await settle();
    expect(isBlocked()).toBe(true);
    expect(dialog()).toHaveAttribute("data-status", "error");
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn’t finish turning on notifications/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(isBlocked()).toBe(false);
    expect(requestPermission).toHaveBeenCalledTimes(1); // Retry never re-prompts
  });

  it("choosing Block in Chrome's prompt switches to the denied instructions", async () => {
    setBrowser("default", "denied");
    render(gate());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Enable Notifications" }));
    await settle();
    expect(dialog()).toHaveAttribute("data-status", "denied");
    expect(isBlocked()).toBe(true);
  });

  it("a dismissed native prompt (no decision) keeps it blocked with a hint and no new prompt", async () => {
    setBrowser("default", "default");
    render(gate());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Enable Notifications" }));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(/No choice was made/);
    expect(isBlocked()).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe("denied permission", () => {
  it("stays blocked, never calls the native prompt, and shows Chrome site-settings instructions that come back every 2 seconds", async () => {
    setBrowser("denied");
    render(gate());
    await settle();
    expect(isBlocked()).toBe(true);
    expect(screen.getByText(/Chrome has blocked notifications/)).toBeInTheDocument();
    expect(screen.getAllByText(/Site settings/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Enable Notifications" })).toBeNull();
    for (let round = 0; round < 3; round++) {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(dialog()).toBeNull();
      expect(isBlocked()).toBe(true);
      await tick(2000);
      expect(dialog()).toHaveAttribute("data-status", "denied");
    }
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("Check Again while still blocked keeps it blocked and does not prompt", async () => {
    setBrowser("denied");
    render(gate());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Check Again" }));
    await settle();
    expect(isBlocked()).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent(/still blocking/);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("Check Again after the member allows notifications in Chrome registers the device and unblocks", async () => {
    setBrowser("denied");
    render(gate());
    await settle();
    perm = "granted"; // changed in Chrome's site settings
    fireEvent.click(screen.getByRole("button", { name: "Check Again" }));
    await settle();
    expect(ensureSubscribed).toHaveBeenCalledWith("anni");
    expect(isBlocked()).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe("denied permission when push is not set up on the server", () => {
  it("is not blocked (it could never be satisfied) and shows no dialog", async () => {
    setBrowser("denied");
    vi.mocked(pushAvailable).mockResolvedValue(false);
    render(gate());
    await settle();
    expect(isBlocked()).toBe(false);
    expect(dialog()).toBeNull();
  });
});

describe("granted permission", () => {
  it("is only unblocked after the subscription is verified on the server (blocked while checking, no hint)", async () => {
    setBrowser("granted");
    let finish!: (v: { ok: true }) => void;
    vi.mocked(ensureSubscribed).mockReturnValue(new Promise((r) => (finish = r)));
    render(gate());
    await settle();
    expect(isBlocked()).toBe(true);
    expect(dialog()).toBeNull(); // nothing to ask yet
    finish({ ok: true });
    await settle();
    expect(isBlocked()).toBe(false);
  });

  it("refresh: a stale local hint never unblocks permanently, a failed server check blocks again", async () => {
    setBrowser("granted");
    vi.mocked(hasRegistrationHint).mockReturnValue(true);
    vi.mocked(ensureSubscribed).mockResolvedValue({ ok: false, reason: "failed" });
    render(gate());
    await settle();
    expect(ensureSubscribed).toHaveBeenCalledTimes(1); // the server is always asked again after a reload
    expect(isBlocked()).toBe(true);
    expect(dialog()).toHaveAttribute("data-status", "error");
  });

  it("refresh: with a hint and a valid subscription the app is open without a prompt", async () => {
    setBrowser("granted");
    vi.mocked(hasRegistrationHint).mockReturnValue(true);
    render(gate());
    await settle();
    expect(isBlocked()).toBe(false);
    expect(dialog()).toBeNull();
    expect(ensureSubscribed).toHaveBeenCalledTimes(1);
  });

  it("registration failure keeps it blocked; Check Again retries once and succeeds", async () => {
    setBrowser("granted");
    vi.mocked(ensureSubscribed).mockResolvedValueOnce({ ok: false, reason: "failed" });
    render(gate());
    await settle();
    expect(dialog()).toHaveAttribute("data-status", "error");
    fireEvent.click(screen.getAllByRole("button", { name: "Check Again" })[0]);
    await settle();
    expect(ensureSubscribed).toHaveBeenCalledTimes(2);
    expect(isBlocked()).toBe(false);
  });

  it("an expired/invalid subscription reported by the service worker blocks again until re-registered", async () => {
    setBrowser("granted");
    const add = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", { value: { addEventListener: add, removeEventListener: vi.fn() }, configurable: true });
    render(gate());
    await settle();
    expect(isBlocked()).toBe(false);
    vi.mocked(ensureSubscribed).mockResolvedValueOnce({ ok: false, reason: "failed" });
    const handler = add.mock.calls.find((c) => c[0] === "message")![1] as (e: unknown) => void;
    await act(async () => handler({ data: { type: "jobsync-push-resubscribe" } }));
    await settle();
    expect(isBlocked()).toBe(true);
  });
});

describe("cases that cannot be satisfied by the member", () => {
  it("unsupported browser: honest message, not blocked, closable, never claims success", async () => {
    setBrowser("unsupported");
    render(gate());
    await settle();
    expect(screen.getByText(/can’t receive JobSync push notifications/)).toBeInTheDocument();
    expect(isBlocked()).toBe(false);
    expect(screen.queryByRole("button", { name: "Enable Notifications" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(dialog()).toBeNull();
    await tick(10_000);
    expect(dialog()).toBeNull();
  });

  it("push not configured on the server: not blocked, no dialog", async () => {
    setBrowser("default");
    vi.mocked(pushAvailable).mockResolvedValue(false);
    render(gate());
    await settle();
    expect(isBlocked()).toBe(false);
    expect(dialog()).toBeNull();
  });
});

describe("accessibility, follow-ups, logout and cleanup", () => {
  it("the dialog has accessible controls for enabling and logging out, and the app is hidden from assistive tech", async () => {
    setBrowser("default");
    const onLogout = vi.fn();
    render(gate({ onLogout }));
    await settle();
    expect(dialog()).toHaveAttribute("role", "alertdialog");
    expect(dialog()).toHaveAttribute("aria-labelledby");
    expect(screen.getByRole("button", { name: "Enable Notifications" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("while a follow-up question is showing, the app stays blocked but the notification dialog waits", async () => {
    setBrowser("default");
    const { rerender } = render(gate({ promptAllowed: false }));
    await settle();
    expect(isBlocked()).toBe(true);
    expect(dialog()).toBeNull();
    rerender(gate({ promptAllowed: true }));
    await settle();
    expect(dialog()).not.toBeNull();
  });

  it("logout cancels the pending 2-second reprompt", async () => {
    setBrowser("default");
    render(gate());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(vi.getTimerCount()).toBe(1);
    // the dialog is closed; log out is performed by the app shell, which unmounts the gate. Simulate via a second render with the dialog back:
    await tick(2000);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(vi.getTimerCount()).toBe(1);
    await tick(2000);
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmounting clears the timer, so nothing fires afterwards", async () => {
    setBrowser("default");
    const { unmount } = render(gate());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await tick(10_000);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("it does not store any permission state of its own", async () => {
    setBrowser("default");
    render(gate());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
});
