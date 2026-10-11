"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AUTO_REFRESH_MS } from "@/config/live";

/**
 * Re-fetches the current page's server data on an interval while the tab is visible, and again
 * when the tab regains visibility/focus. Client state (open dialogs, typed form text) is kept.
 */
export function AutoRefresh({ intervalMs = AUTO_REFRESH_MS }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      last = Date.now();
      router.refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last > Math.min(10_000, intervalMs)) refresh();
    };
    const id = window.setInterval(refresh, intervalMs);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [router, intervalMs]);
  return null;
}
