"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BellRing, Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";
import { ensureSubscribed, hasRegistrationHint, pushAvailable, pushSupported } from "@/lib/push/browser";

type Status = "checking" | "ready" | "default" | "denied" | "error" | "unsupported" | "unavailable";

/** After "Not now" / closing, JobSync's own dialog is gone for this long, then shown again (repeats while setup is incomplete). */
export const REPROMPT_MS = 2000;

/** Works out the state from the browser AND the server. Never asks for permission (only a click may). */
async function evaluate(memberId: string): Promise<Status> {
  if (!pushSupported()) return "unsupported";
  const permission = Notification.permission;
  if (permission !== "granted") {
    // If the server cannot do push at all (keys or sheet tab missing) the member could never satisfy the gate.
    if (!(await pushAvailable())) return "unavailable";
    return permission === "denied" ? "denied" : "default";
  }
  // granted: only counts once a push subscription exists AND the server has it stored for this member
  const r = await ensureSubscribed(memberId);
  return r.ok ? "ready" : r.reason === "unconfigured" ? "unavailable" : "error";
}

/**
 * Notification gate for every protected page.
 *
 * Until this browser has granted notification permission AND a push subscription is registered on the server for the
 * signed-in member, everything inside `children` is blurred, inert and unreadable, and a notification dialog is
 * shown. "Not now" hides the dialog for a moment and brings it straight back. The state is re-derived on every full
 * page load from the browser and the server (nothing "unblocked" survives a refresh by itself).
 *
 * Not blocked, because they cannot be satisfied by the member: browsers without Push/service-worker support (an
 * explanatory notice is shown instead) and servers where push is not configured. Log out stays available in the
 * dialog. The native permission prompt is only requested from the Enable button (a user gesture) and never again
 * once Chrome reports "denied".
 *
 * This is a UI gate: page data is still sent to the signed-in member's browser, so it is not a security boundary
 * (the session and per-member authorization still protect the data itself).
 */
export function NotificationGate({
  memberId,
  promptAllowed = true,
  onLogout,
  logoutBusy = false,
  children,
}: {
  memberId: string;
  /** False while another blocking dialog (the 7-day follow-up question) is showing, so only one modal is up at a time. */
  promptAllowed?: boolean;
  onLogout: () => void;
  logoutBusy?: boolean;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<Status>("checking");
  const [hinted, setHinted] = useState(false);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [noticeClosed, setNoticeClosed] = useState(false);

  // Every full page load: re-check the browser and the server. The hint only avoids a flash of blur while doing so.
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => {
      if (live) setHinted(hasRegistrationHint(memberId));
    });
    void evaluate(memberId).then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, [memberId]);

  // The service worker asks open pages to re-register when the browser rotates or expires the subscription.
  useEffect(() => {
    if (!pushSupported()) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "jobsync-push-resubscribe") void evaluate(memberId).then(setStatus);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [memberId]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const blocking = status === "default" || status === "denied" || status === "error";
  const blurred = blocking || (status === "checking" && !hinted);
  const showDialog = blocking && promptAllowed && open;
  const showNotice = status === "unsupported" && promptAllowed && !noticeClosed;

  // Keep the native modal dialog open while it should be shown (a browser-initiated close re-opens it).
  const dialogVisible = showDialog || showNotice;
  useEffect(() => {
    const el = dialogRef.current;
    if (!el || !dialogVisible) return;
    if (!el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    }
  }, [dialogVisible]);

  /**
   * "Not now" / close / Escape: JobSync's own dialog disappears and returns after REPROMPT_MS, again and again while
   * setup is incomplete. At most one timer exists; the application stays blurred throughout. This never touches the
   * browser's permission API.
   */
  const notNow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
    setMessage("Notifications are required to use JobSync. Please enable them to continue.");
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(true);
    }, REPROMPT_MS);
  }, []);

  function logout() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    onLogout();
  }

  async function enable() {
    if (busy || !pushSupported()) return;
    setBusy(true);
    setMessage(null);
    try {
      // The only place the native permission prompt is requested: a deliberate click.
      const permission = await Notification.requestPermission();
      if (permission === "denied") return setStatus("denied");
      if (permission !== "granted") return setMessage("No choice was made in the browser prompt. Click Enable Notifications to try again.");
      await recheck("We couldn’t finish turning on notifications on this device. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  /** Re-reads permission and subscription state (after browser-settings changes or a failure) and retries registration. */
  async function recheck(failureMessage: string) {
    const next = await evaluate(memberId);
    setStatus(next);
    if (next === "error") setMessage(failureMessage);
    else if (next === "denied") setMessage("Chrome is still blocking notifications for JobSync.");
    else setMessage(null);
  }

  async function checkAgain() {
    if (busy) return;
    setBusy(true);
    try {
      await recheck("Notifications are allowed, but this device could not be registered. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const title =
    status === "denied" ? "Notifications are blocked" : status === "error" ? "Finish turning on notifications" : status === "unsupported" ? "Notifications aren’t available here" : "Turn on notifications";

  return (
    <>
      {/* The whole application. Blurred and inert (no clicks, focus or screen-reader access) until setup succeeds. */}
      <div
        data-notification-gate={blurred ? "blocked" : "open"}
        inert={blurred}
        aria-hidden={blurred || undefined}
        className={blurred ? "pointer-events-none select-none" : undefined}
        style={blurred ? { filter: "blur(18px)" } : undefined}
      >
        {children}
      </div>

      {(showDialog || showNotice) && (
        <dialog
          ref={dialogRef}
          role="alertdialog"
          aria-labelledby={titleId}
          aria-describedby={descId}
          data-testid="notification-onboarding"
          data-status={status}
          // Escape counts as "Not now" for the blocking prompt, and a browser-initiated close brings it back.
          onCancel={(e) => {
            e.preventDefault();
            if (showDialog) notNow();
            else setNoticeClosed(true);
          }}
          onClose={() => {
            const el = dialogRef.current;
            if (el && !el.open && dialogVisible && typeof el.showModal === "function") el.showModal();
          }}
          className="m-auto w-[calc(100%-1.5rem)] max-w-lg overflow-y-auto rounded-2xl border border-line bg-navy-900 p-0 text-ink shadow-2xl backdrop:bg-black/60"
          style={{
            maxHeight: "calc(100dvh - 1.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
            marginTop: "max(0.75rem, env(safe-area-inset-top))",
            marginBottom: "max(0.75rem, env(safe-area-inset-bottom))",
          }}
        >
          <div className="space-y-4 p-4 sm:p-6">
            <Logo />
            <h2 id={titleId} className="text-xl font-bold leading-snug sm:text-2xl">
              {title}
            </h2>
            <div id={descId} className="space-y-3 text-base leading-relaxed">
              <p className="flex items-start gap-3">
                <BellRing size={22} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                <span>
                  {status === "default" && "Enable notifications to know immediately when Anni, Lukky, or Rishii adds a job or applies for one."}
                  {status === "error" && "Notifications are allowed, but we couldn’t register this device to receive them. JobSync stays locked until this works."}
                  {status === "denied" && "Chrome has blocked notifications for JobSync. JobSync stays locked until you allow them, so you never miss it when Anni, Lukky, or Rishii adds a job or applies for one."}
                  {status === "unsupported" && "This browser can’t receive JobSync push notifications, so you can keep using JobSync here but won’t be notified."}
                </span>
              </p>

              {status === "denied" && (
                <ol className="list-decimal space-y-1.5 rounded-lg border border-line bg-navy-950/60 py-3 pl-8 pr-3 text-sm text-ink/90">
                  <li>Tap or click the lock (or settings) icon beside the web address.</li>
                  <li>Open <strong>Permissions</strong> / <strong>Site settings</strong> and set <strong>Notifications</strong> to <strong>Allow</strong>.</li>
                  <li>Come back here and press <strong>Check Again</strong>.</li>
                  <li>On Android you can also use Chrome ⋮ → Settings → Site settings → Notifications.</li>
                </ol>
              )}
              {status === "error" && (
                <ul className="list-disc space-y-1 rounded-lg border border-line bg-navy-950/60 py-3 pl-8 pr-3 text-sm text-ink/90">
                  <li>Check your internet connection and that Chrome is up to date.</li>
                  <li>Turn off battery or data saver restrictions for Chrome, then retry.</li>
                  <li>If it keeps failing, reload the page or sign out and back in.</li>
                </ul>
              )}
              {status === "unsupported" && (
                <ul className="list-disc space-y-1 rounded-lg border border-line bg-navy-950/60 py-3 pl-8 pr-3 text-sm text-ink/90">
                  <li>Use Google Chrome on Android or on a computer, over the secure (https) site.</li>
                  <li>Private/incognito windows and some in-app browsers don’t support push.</li>
                  <li>On iPhone/iPad, push is only available for web apps added to the Home Screen.</li>
                </ul>
              )}
            </div>

            {message && (
              <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-100">
                {message}
              </p>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Button variant="ghost" onClick={logout} disabled={logoutBusy}>
                <LogOut size={16} aria-hidden />
                Log out
              </Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                {status === "default" && (
                  <>
                    <Button variant="secondary" onClick={notNow}>
                      Not now
                    </Button>
                    <Button variant="primary" onClick={enable} disabled={busy}>
                      {busy && <Loader2 size={16} className="animate-spin" aria-hidden />}
                      Enable Notifications
                    </Button>
                  </>
                )}
                {status === "error" && (
                  <>
                    <Button variant="secondary" onClick={notNow}>
                      Close
                    </Button>
                    <Button variant="secondary" onClick={checkAgain} disabled={busy}>
                      Check Again
                    </Button>
                    <Button variant="primary" onClick={checkAgain} disabled={busy}>
                      {busy && <Loader2 size={16} className="animate-spin" aria-hidden />}
                      Retry
                    </Button>
                  </>
                )}
                {status === "denied" && (
                  <>
                    <Button variant="secondary" onClick={notNow}>
                      Close
                    </Button>
                    <Button variant="primary" onClick={checkAgain} disabled={busy}>
                      {busy && <Loader2 size={16} className="animate-spin" aria-hidden />}
                      Check Again
                    </Button>
                  </>
                )}
                {status === "unsupported" && (
                  <Button variant="primary" onClick={() => setNoticeClosed(true)}>
                    Continue
                  </Button>
                )}
              </div>
            </div>
          </div>
        </dialog>
      )}
    </>
  );
}
