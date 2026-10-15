"use client";

import { useSyncExternalStore } from "react";

/**
 * One shared poller for the unread-message count (sidebar badge and the mobile menu dot), so several components
 * cost one request, and none while the tab is hidden. The chat page itself reports reads through `setUnread`.
 */
const POLL_MS = 20_000;

let count = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight = false;

function emit() {
  for (const l of listeners) l();
}

export function setUnread(n: number) {
  if (n === count) return;
  count = n;
  emit();
}

async function refresh() {
  if (inflight || document.visibilityState === "hidden") return;
  inflight = true;
  try {
    const res = await fetch("/api/chat/unread", { cache: "no-store" });
    if (res.ok) {
      const body = await res.json();
      setUnread(typeof body?.data?.unread === "number" ? body.data.unread : 0);
    }
  } catch {
    /* offline: keep the last known value */
  } finally {
    inflight = false;
  }
}

function onVisible() {
  if (document.visibilityState === "visible") void refresh();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

/** Number of unread group-chat messages (0 on the chat page itself). */
export function useChatUnread(): number {
  return useSyncExternalStore(subscribe, () => count, () => 0);
}
