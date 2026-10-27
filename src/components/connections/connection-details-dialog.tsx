"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Link2, Pencil, Trash2 } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { getMember } from "@/config/members";
import { formatDisplayDate } from "@/lib/jobs/query";
import type { Connection, ConnectionStatus } from "@/types/domain";
import { ConnectionStatusControl } from "./connection-status";
import { GmailDraftStatus } from "./gmail-draft-status";

/** Copies text to the clipboard; falls back to a hidden textarea where the async API is unavailable. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const done = document.execCommand("copy");
      ta.remove();
      return done;
    } catch {
      return false;
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

/** Everything saved for one connection (the list only shows the headline facts). */
export function ConnectionDetailsDialog({ c, mine, timeZone, busy, onStatus, onEdit, onDelete, onCopied, onClose }: {
  c: Connection;
  mine: boolean;
  timeZone: string;
  busy: boolean;
  onStatus: (s: ConnectionStatus) => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopied: (ok: boolean) => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const adder = getMember(c.memberId);
  async function copy() {
    const ok = await copyText(c.message ?? "");
    onCopied(ok);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }
  return (
    <Dialog title="Connection details" wide onClose={onClose}>
      <div data-testid="connection-details">
        <p className="break-words text-xl font-semibold leading-snug">{c.name}</p>
        {(c.role || c.company) && <p className="mt-0.5 break-words text-muted">{[c.role, c.company].filter(Boolean).join(" · ")}</p>}

        <dl className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Company">{c.company ?? "—"}</Field>
          <Field label="Role / title">{c.role ?? "—"}</Field>
          <Field label="Email">
            {c.email ? (
              <a href={`mailto:${c.email}`} className="break-all text-electric-soft hover:underline" data-testid="connection-email">
                {c.email}
              </a>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Status">
            <ConnectionStatusControl c={c} mine={mine} busy={busy} onStatus={onStatus} />
          </Field>
          <Field label="Added">
            {adder ? (
              <span className="flex items-center gap-2" data-testid="connection-added-by">
                <Avatar member={adder} size={20} />
                <span>
                  Added by <strong style={{ color: adder.accentText }}>{mine ? "you" : adder.name}</strong> on{" "}
                  <time dateTime={c.createdAt}>{formatDisplayDate(c.createdAt, timeZone)}</time>
                </span>
              </span>
            ) : (
              formatDisplayDate(c.createdAt, timeZone)
            )}
          </Field>
          <Field label="Last updated">
            <time dateTime={c.updatedAt}>{formatDisplayDate(c.updatedAt, timeZone)}</time>
          </Field>
        </dl>

        <div className="mt-5 rounded-lg border border-line bg-navy-950/60 p-3">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Message to send</h3>
            {c.message && (
              <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs font-medium text-ink hover:border-electric-soft">
                {copied ? <Check size={14} aria-hidden className="text-emerald-300" /> : <Copy size={14} aria-hidden />}
                {copied ? "Copied" : "Copy message"}
              </button>
            )}
          </div>
          {c.message ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="connection-message">
              {c.message}
            </p>
          ) : (
            <p className="text-sm text-muted">No message written yet.{mine ? " Use Edit to add one." : ""}</p>
          )}
        </div>

        <GmailDraftStatus connectionId={c.connectionId} />

        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Profile &amp; links</h3>
          {c.profileUrl || c.otherUrl ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {c.profileUrl && (
                <a href={c.profileUrl} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:border-electric-soft">
                  <ExternalLink size={14} aria-hidden className="shrink-0" />
                  <span className="truncate">Open profile ({hostOf(c.profileUrl)})</span>
                </a>
              )}
              {c.otherUrl && (
                <a href={c.otherUrl} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:border-electric-soft">
                  <Link2 size={14} aria-hidden className="shrink-0" />
                  <span className="truncate">{hostOf(c.otherUrl)}</span>
                </a>
              )}
            </div>
          ) : (
            <p className="mt-1 text-sm text-muted">No links saved.</p>
          )}
        </div>

        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Notes</h3>
          {c.notes ? <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink/90">{c.notes}</p> : <p className="mt-1 text-sm text-muted">No notes.</p>}
        </div>

        {mine ? (
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button onClick={onEdit} aria-label={`Edit ${c.name}`}>
              <Pencil size={16} aria-hidden /> Edit
            </Button>
            <Button onClick={onDelete} className="text-red-300 hover:border-red-400" aria-label={`Delete ${c.name}`}>
              <Trash2 size={16} aria-hidden /> Delete
            </Button>
          </div>
        ) : (
          <p className="mt-6 text-xs text-muted">Only {adder?.name ?? "the member who added it"} can edit or delete this entry.</p>
        )}
      </div>
    </Dialog>
  );
}
