// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));

import { AutoRefresh } from "@/components/layout/auto-refresh";
import { AUTO_REFRESH_MS } from "@/config/live";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockReset();
  setVisibility("visible");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AutoRefresh (near-real-time updates from other members)", () => {
  it("defaults to 30 seconds", () => {
    expect(AUTO_REFRESH_MS).toBe(30_000);
  });

  it("re-fetches the page data on every interval while the tab is visible", () => {
    render(<AutoRefresh intervalMs={30_000} />);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("does not poll while the tab is hidden", () => {
    setVisibility("hidden");
    render(<AutoRefresh intervalMs={30_000} />);
    vi.advanceTimersByTime(120_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes right away when the tab becomes visible again after a while", () => {
    render(<AutoRefresh intervalMs={30_000} />);
    setVisibility("hidden");
    vi.advanceTimersByTime(25_000);
    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not hammer the server when visibility flips repeatedly", () => {
    render(<AutoRefresh intervalMs={30_000} />);
    vi.advanceTimersByTime(30_000); // 1 refresh
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops polling when unmounted", () => {
    const view = render(<AutoRefresh intervalMs={30_000} />);
    view.unmount();
    vi.advanceTimersByTime(120_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
