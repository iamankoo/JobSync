"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { removeThisDevice } from "@/lib/push/browser";

/** The app's one logout: detaches this browser's notifications, ends the session cookie, goes to /login. */
export function useLogout(): { logout: () => Promise<void>; busy: boolean } {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      // Detach this browser from the member before the session ends (other devices keep their notifications).
      await removeThisDevice();
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }
  return { logout, busy };
}
