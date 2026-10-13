"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Logo } from "@/components/ui/logo";
import { ensureSubscribed, pushAvailable, pushSupported, type EnsureResult } from "@/lib/push/browser";

type Status = "checking" | "unsupported" | "default" | "denied" | "ready" | "error" | "unavailable";

/** Browser-only starting point. On the server (and for granted permission) it stays "checking" until registration ends. */
function initialStatus(): Status {
  if (typeof window === "undefined") return "checking";
  if (!pushSupported()) return "unsupported";
  const p = Notification.permission;
  // "default" is confirmed against the server first (see the effect) so members are only invited when push can work.
  return p === "denied" ? "denied" : "checking";
}

const dismissKey = (memberId: string) => `jobsync:push-onboarding:${memberId}`;

/**
 * Chrome push notifications for the signed-in member.
 *
 *  - permission `granted`: silently (re)registers this browser on every app page. No dialog.
 *  - `default`: on the Dashboard shows the onboarding dialog. The native permission prompt appears ONLY after
 *    the member clicks "Enable Notifications" (never automatically).
 *  - `denied`: explains how to unblock notifications in Chrome. The native prompt is never called again.
 *  - unsupported browser: explains that push is unavailable.
 *
 * The dialog is dismissible ("Not now", Escape, X) and stays dismissed for the rest of the browser session, so it
 * can never trap the member or loop. It renders nothing else and does not touch the page layout.
 */
export function NotificationManager({ memberId, showOnboarding }: { memberId: string; showOnboarding: boolean }) {
  const [status, setStatus] = useState<Status>(initialStatus);
  // Nothing is rendered until the permission check has finished, so reading storage during init is safe.
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(dismissKey(memberId)) === "1";
    } catch {
      return false;
    }
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const applyResult = useCallback((r: EnsureResult) => {
    setStatus(r.ok ? "ready" : r.reason === "unconfigured" ? "unavailable" : "error");
    return r.ok;
  }, []);
  const register = useCallback(() => ensureSubscribed(memberId).then(applyResult), [memberId, applyResult]);

  const evaluate = useCallback(async () => {
    if (!pushSupported()) return setStatus("unsupported");
    const permission = Notification.permission;
    if (permission === "denied") return setStatus("denied");
    if (permission === "default") return setStatus("default");
    await register();
  }, [register]);

  useEffect(() => {
    // Permission already granted: silently (re)register this browser. Nothing is asked of the member.
    if (!pushSupported()) return;
    if (Notification.permission === "granted") void ensureSubscribed(memberId).then(applyResult);
    else if (Notification.permission === "default") void pushAvailable().then((yes) => setStatus(yes ? "default" : "unavailable"));
  }, [memberId, applyResult]);

  // The service worker asks open pages to re-register when the browser rotates the subscription.
  useEffect(() => {
    if (!pushSupported()) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "jobsync-push-resubscribe" && Notification.permission === "granted") void register();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [register]);

  function dismiss() {
    setDismissed(true);
    setMessage(null);
    try {
      sessionStorage.setItem(dismissKey(memberId), "1");
    } catch {
      /* the dialog may reappear on the next Dashboard visit; harmless */
    }
  }

  async function enable() {
    if (busy || !pushSupported()) return;
    setBusy(true);
    setMessage(null);
    try {
      // The only place the native permission prompt is requested: a deliberate click.
      const permission = await Notification.requestPermission();
      if (permission === "denied") setStatus("denied");
      else if (permission === "granted") {
        if (!(await register())) setMessage("We couldn't finish turning on notifications. Please try again.");
      } else setMessage("No choice was made in the browser prompt. Click Enable Notifications to try again, or choose Not now.");
    } finally {
      setBusy(false);
    }
  }

  async function checkAgain() {
    setBusy(true);
    setMessage(null);
    try {
      await evaluate();
    } finally {
      setBusy(false);
    }
  }

  const needsDialog = status === "default" || status === "denied" || status === "unsupported" || status === "error";
  if (!showOnboarding || dismissed || !needsDialog) return null;

  const title = status === "denied" ? "Notifications are blocked" : status === "unsupported" ? "Notifications aren’t available here" : status === "error" ? "Finish turning on notifications" : "Turn on notifications";

  return (
    <Dialog title={title} onClose={dismiss}>
      <div className="space-y-4" data-testid="notification-onboarding" data-status={status}>
        <div className="flex items-center gap-3">
          <Logo />
        </div>
        <p className="flex items-start gap-3 text-base leading-relaxed">
          <BellRing size={22} className="mt-0.5 shrink-0 text-accent" aria-hidden />
          <span>
            {status === "default" && "Enable notifications to know immediately when Anni, Lukky, or Rishii adds a job or applies for one."}
            {status === "error" && "Your browser allowed notifications, but we couldn’t finish setting them up on this device. Please try again."}
            {status === "denied" && "Chrome has blocked notifications for JobSync, so you won’t hear when Anni, Lukky, or Rishii adds a job or applies for one."}
            {status === "unsupported" && "This browser doesn’t support push notifications for JobSync. Use Google Chrome on Android or desktop to get notified when Anni, Lukky, or Rishii adds a job or applies for one."}
          </span>
        </p>

        {status === "denied" && (
          <ol className="list-decimal space-y-1.5 rounded-lg border border-line bg-navy-950/60 py-3 pl-8 pr-3 text-sm text-ink/90">
            <li>Tap or click the lock (or settings) icon beside the web address.</li>
            <li>Open <strong>Permissions</strong> / <strong>Site settings</strong> and set <strong>Notifications</strong> to <strong>Allow</strong>.</li>
            <li>Come back here and press <strong>Check again</strong>.</li>
            <li>On Android you can also use Chrome ⋮ → Settings → Site settings → Notifications.</li>
          </ol>
        )}

        {message && (
          <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-100">
            {message}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={dismiss}>
            {status === "default" || status === "error" ? "Not now" : "Close"}
          </Button>
          {(status === "default" || status === "error") && (
            <Button variant="primary" onClick={enable} disabled={busy}>
              {busy && <Loader2 size={16} className="animate-spin" aria-hidden />}
              {status === "error" ? "Try again" : "Enable Notifications"}
            </Button>
          )}
          {status === "denied" && (
            <Button variant="primary" onClick={checkAgain} disabled={busy}>
              {busy && <Loader2 size={16} className="animate-spin" aria-hidden />}
              Check again
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
