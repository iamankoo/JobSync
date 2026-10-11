"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, Loader2, Star, Trophy, Users, type LucideIcon } from "lucide-react";
import { CompanyMark } from "@/components/ui/company-mark";
import { apiRequest } from "@/lib/client/api";
import { formatDisplayDate } from "@/lib/jobs/query";
import type { FollowUpAnswer } from "@/types/domain";

export interface DueFollowUpItem {
  jobId: string;
  company: string;
  jobRole: string;
  /** ISO 8601 UTC: when the member applied. */
  appliedAt: string;
}

const CHOICES: { answer: FollowUpAnswer; label: string; icon: LucideIcon }[] = [
  { answer: "Shortlisted", label: "Yes, I've been shortlisted", icon: Star },
  { answer: "Interview", label: "I've received an interview call", icon: Users },
  { answer: "Offer", label: "I've received an offer", icon: Trophy },
  { answer: "No update", label: "No update yet", icon: Clock },
];

/**
 * Blocking follow-up question, shown before the member can use the site, one due job at a time.
 *
 * It cannot be dismissed: no close button, Escape and backdrop clicks do nothing, and the native
 * modal <dialog> makes the rest of the page inert. It lives in the shared app layout, so it also
 * covers every page and every navigation. Each answer is saved on the server BEFORE the next
 * question appears; if saving fails the question stays open with a retry. What is due is decided
 * on the server (168 h after applying); nothing here starts or checks a timer.
 */
export function FollowUpGate({ items, timeZone }: { items: DueFollowUpItem[]; timeZone: string }) {
  const router = useRouter();
  const titleId = useId();
  const descId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<FollowUpAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = items.filter((i) => !answered.has(i.jobId));
  const current = pending[0];
  const open = Boolean(current);
  // Progress is counted from what was answered in this visit plus what is still pending, so it stays
  // correct when the refreshed list from the server no longer contains the already-answered questions.
  const total = answered.size + pending.length;
  const position = answered.size + 1;

  // Show as a MODAL and keep it open: if the browser ever closes it, re-open while questions remain.
  useEffect(() => {
    const el = ref.current;
    if (!el || !open) return;
    if (!el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    }
  }, [open]);

  // Move focus to the first choice whenever a (new) question appears.
  useEffect(() => {
    if (current) firstChoice.current?.focus();
  }, [current?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function answer(choice: FollowUpAnswer) {
    if (!current || busy) return;
    setBusy(choice);
    setError(null);
    const res = await apiRequest(`/api/follow-ups/${encodeURIComponent(current.jobId)}`, {
      method: "POST",
      body: JSON.stringify({ answer: choice }),
    });
    setBusy(null);
    if (res.ok || res.status === 404 || res.code === "follow_up_not_applicable") {
      // Saved (or no longer applicable, e.g. answered in another tab): move on, then refresh page data
      // so every count and status reflects what was just saved.
      setAnswered((prev) => new Set(prev).add(current.jobId));
      router.refresh();
      return;
    }
    if (res.code === "follow_up_conflict") {
      // Already answered elsewhere with a different answer: that answer stands; do not ask again.
      setAnswered((prev) => new Set(prev).add(current.jobId));
      router.refresh();
      return;
    }
    setError(res.message);
  }

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descId}
      // Escape ("cancel") must not close it, and a browser-initiated close re-opens it (see effect).
      onCancel={(e) => e.preventDefault()}
      onClose={() => {
        const el = ref.current;
        if (el && !el.open && open) {
          if (typeof el.showModal === "function") el.showModal();
        }
      }}
      className="m-auto w-[calc(100%-1.5rem)] max-w-lg overflow-y-auto rounded-2xl border border-line bg-navy-900 p-0 text-ink shadow-2xl backdrop:bg-black/80"
      style={{
        maxHeight: "calc(100dvh - 1.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
        marginTop: "max(0.75rem, env(safe-area-inset-top))",
        marginBottom: "max(0.75rem, env(safe-area-inset-bottom))",
      }}
    >
      <div className="p-4 sm:p-6">
        {total > 1 && (
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted" aria-live="polite">
            Question {position} of {total}
          </p>
        )}
        <h2 id={titleId} className="text-xl font-bold leading-snug sm:text-2xl">
          What&apos;s the current status of this application?
        </h2>

        <div id={descId} className="mt-4 flex items-center gap-3 rounded-xl border border-line bg-navy-950/60 p-3 sm:p-4">
          <CompanyMark name={current.company} size={44} />
          <div className="min-w-0">
            <p className="break-words text-base font-semibold leading-tight sm:text-lg">{current.jobRole}</p>
            <p className="break-words text-sm text-ink/90">{current.company}</p>
            <p className="mt-0.5 text-xs text-muted">Applied on {formatDisplayDate(current.appliedAt, timeZone)}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-2.5 sm:gap-3">
          {CHOICES.map(({ answer: choice, label, icon: Icon }, i) => (
            <button
              key={choice}
              ref={i === 0 ? firstChoice : undefined}
              type="button"
              disabled={busy !== null}
              onClick={() => answer(choice)}
              className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-line bg-navy-800 px-4 py-3 text-left text-base font-semibold transition hover:border-accent hover:bg-navy-700 focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.99]"
            >
              {busy === choice ? <Loader2 size={22} className="shrink-0 animate-spin" aria-hidden /> : <Icon size={22} className="shrink-0 text-accent" aria-hidden />}
              <span>{label}</span>
            </button>
          ))}
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-sm text-red-100">
            Your answer could not be saved: {error} Please try again. You can continue once it is saved.
          </p>
        )}
      </div>
    </dialog>
  );
}
