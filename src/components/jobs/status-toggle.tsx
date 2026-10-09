"use client";

import { Check, Loader2, X } from "lucide-react";
import type { ApplicationStatus } from "@/types/domain";
import { isApplied } from "@/lib/jobs/stats";

interface Props {
  status: ApplicationStatus;
  /** "Role at Company", used in the accessible name. */
  jobLabel: string;
  busy?: boolean;
  onToggle: () => void;
}

/**
 * The single personal status indicator: green tick = Applied, red cross = Not Applied.
 * Clicking switches between Applied and Not Applied for the signed-in member only.
 * Later stages (In Progress, Interview, ...) show the tick but are managed from My Applications.
 */
export function StatusToggle({ status, jobLabel, busy = false, onToggle }: Props) {
  const applied = isApplied(status);
  const locked = applied && status !== "Applied";
  const label = locked
    ? `${jobLabel}: ${status}. Manage this in My Applications`
    : applied
      ? `${jobLabel}: Applied. Mark as not applied`
      : `${jobLabel}: Not applied. Mark as applied`;
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy || locked}
      aria-label={label}
      title={locked ? `${status}: manage in My Applications` : applied ? "Applied: click to undo" : "Not applied: click to mark as applied"}
      className={`grid h-9 w-12 place-items-center rounded-lg border transition disabled:cursor-not-allowed ${
        applied
          ? "border-emerald-500/60 bg-emerald-600/25 text-emerald-300 hover:bg-emerald-600/40"
          : "border-red-500/60 bg-red-600/25 text-red-300 hover:bg-red-600/40"
      } ${busy ? "opacity-70" : ""}`}
    >
      {busy ? <Loader2 size={18} className="animate-spin" aria-hidden /> : applied ? <Check size={20} aria-hidden /> : <X size={20} aria-hidden />}
    </button>
  );
}
