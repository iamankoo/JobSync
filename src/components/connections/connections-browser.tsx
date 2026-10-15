"use client";

import { useMemo, useState } from "react";
import { Building2, Check, Copy, ExternalLink, Link2, Pencil, Plus, Search, SearchX, Trash2, UserPlus, Users } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { getMember, type MemberId } from "@/config/members";
import { Avatar } from "@/components/ui/avatar";
import { deleteConnectionRequest, updateConnectionRequest } from "@/lib/client/api";
import { CONNECTION_STATUSES, type Connection, type ConnectionStatus } from "@/types/domain";
import { ConnectionForm } from "./connection-form";

const STATUS_STYLE: Record<ConnectionStatus, string> = {
  "Not Connected": "border-slate-500/40 bg-slate-500/15 text-slate-200",
  Connected: "border-blue-500/40 bg-blue-500/15 text-blue-200",
  Messaged: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  Reply: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
};

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

function ConnectionCard({ c, mine, timeZone, busy, onStatus, onEdit, onDelete, onCopied }: {
  c: Connection;
  mine: boolean;
  timeZone: string;
  busy: boolean;
  onStatus: (s: ConnectionStatus) => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopied: (ok: boolean) => void;
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
    <li className="flex flex-col gap-3 rounded-xl border border-line bg-navy-900 p-4" data-testid="connection-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-semibold leading-snug">{c.name}</h2>
          {(c.role || c.company) && (
            <p className="mt-0.5 flex items-start gap-1.5 break-words text-sm text-muted">
              <Building2 size={14} aria-hidden className="mt-0.5 shrink-0" />
              <span>{[c.role, c.company].filter(Boolean).join(" · ")}</span>
            </p>
          )}
        </div>
        <span className={`shrink-0 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-semibold ${STATUS_STYLE[c.status]}`}>{c.status}</span>
      </div>

      {adder && (
        <p className="flex items-center gap-2 text-xs text-muted" data-testid="connection-added-by">
          <Avatar member={adder} size={20} />
          <span>
            Added by <strong style={{ color: adder.accentText }}>{mine ? "you" : adder.name}</strong> on{" "}
            <time dateTime={c.createdAt}>{new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(new Date(c.createdAt))}</time>
          </span>
        </p>
      )}

      <label className="block text-xs font-medium text-muted">
        Status
        <select
          value={c.status}
          disabled={busy || !mine}
          onChange={(e) => onStatus(e.target.value as ConnectionStatus)}
          aria-label={`Status of ${c.name}`}
          className="mt-1 h-10 w-full rounded-lg border border-line bg-navy-950/60 px-3 text-sm text-ink outline-none hover:border-electric-soft focus-visible:border-electric-soft disabled:opacity-60"
        >
          {CONNECTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <div className="rounded-lg border border-line bg-navy-950/60 p-3">
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
          <p className="text-sm text-muted">No message written yet. Use Edit to add one.</p>
        )}
      </div>

      {(c.profileUrl || c.otherUrl) && (
        <div className="flex flex-wrap gap-2">
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
      )}

      {c.notes && <p className="whitespace-pre-wrap break-words text-sm text-muted">{c.notes}</p>}

      {mine ? (
      <div className="mt-auto flex justify-end gap-2 pt-1">
        <Button onClick={onEdit} className="px-3 py-2" aria-label={`Edit ${c.name}`}>
          <Pencil size={14} aria-hidden /> Edit
        </Button>
        <Button onClick={onDelete} variant="ghost" className="px-3 py-2 hover:text-red-300" aria-label={`Delete ${c.name}`}>
          <Trash2 size={14} aria-hidden /> Delete
        </Button>
      </div>
      ) : (
        <p className="mt-auto pt-1 text-xs text-muted">Only {adder?.name ?? "the member who added it"} can edit or delete this entry.</p>
      )}
    </li>
  );
}

/** The SHARED people-to-connect-with list (everyone sees everything; only the adder edits). Tracking only: nothing is ever sent to LinkedIn or anyone else. */
export function ConnectionsBrowser({ connections: initial, me, timeZone }: { connections: Connection[]; me: MemberId; timeZone: string }) {
  const [items, setItems] = useState(initial);
  const [seen, setSeen] = useState(initial);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"" | ConnectionStatus>("");
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [deleting, setDeleting] = useState<Connection | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  // Fresh data from the background refresh replaces the list.
  if (initial !== seen) {
    setSeen(initial);
    setItems(initial);
  }

  const counts = useMemo(() => {
    const out = Object.fromEntries(CONNECTION_STATUSES.map((s) => [s, 0])) as Record<ConnectionStatus, number>;
    for (const c of items) out[c.status] += 1;
    return out;
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((c) => {
      if (status && c.status !== status) return false;
      if (!q) return true;
      return [c.name, c.company, c.role, c.message, c.notes, c.profileUrl, getMember(c.memberId)?.name].some((v) => v?.toLowerCase().includes(q));
    });
  }, [items, query, status]);

  async function changeStatus(c: Connection, next: ConnectionStatus) {
    if (next === c.status) return;
    setBusyId(c.connectionId);
    const res = await updateConnectionRequest(c.connectionId, { status: next });
    setBusyId(null);
    if (res.ok) {
      setItems((list) => list.map((x) => (x.connectionId === c.connectionId ? res.data : x)));
      setNotice({ kind: "success", text: `${c.name} marked as ${next}.` });
    } else setNotice({ kind: "error", text: res.message });
  }

  async function confirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setBusyId(target.connectionId);
    const res = await deleteConnectionRequest(target.connectionId);
    setBusyId(null);
    setDeleting(null);
    if (res.ok) {
      setItems((list) => list.filter((x) => x.connectionId !== target.connectionId));
      setNotice({ kind: "success", text: `${target.name} was removed.` });
    } else setNotice({ kind: "error", text: res.message });
  }

  function saved(c: Connection) {
    const isNew = editing === "new";
    setItems((list) => (isNew ? [c, ...list] : list.map((x) => (x.connectionId === c.connectionId ? c : x))));
    setEditing(null);
    setNotice({ kind: "success", text: isNew ? `${c.name} was added.` : `${c.name} was updated.` });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title="Connections" subtitle="Whom should I connect with, and what message should I send?" />
        <Button variant="primary" onClick={() => setEditing("new")}>
          <Plus size={16} aria-hidden /> Add connection
        </Button>
      </div>

      <Notice notice={notice} onDismiss={() => setNotice(null)} />

      {items.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
            <button
              type="button"
              onClick={() => setStatus("")}
              aria-pressed={status === ""}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${status === "" ? "border-accent bg-accent-strong text-on-accent" : "border-line bg-navy-900 hover:border-electric-soft"}`}
            >
              All ({items.length})
            </button>
            {CONNECTION_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(status === s ? "" : s)}
                aria-pressed={status === s}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${status === s ? "border-accent bg-accent-strong text-on-accent" : "border-line bg-navy-900 hover:border-electric-soft"}`}
              >
                {s} ({counts[s]})
              </button>
            ))}
          </div>
          <div className="relative max-w-xl">
            <label htmlFor="connections-search" className="sr-only">
              Search connections by name, company, role or message
            </label>
            <Search size={18} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              id="connections-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, company, role, message…"
              className="h-11 w-full rounded-lg border border-line bg-navy-900 pl-10 pr-3 text-sm text-ink outline-none placeholder:text-muted hover:border-electric-soft focus-visible:border-electric-soft"
            />
          </div>
        </>
      )}

      {items.length === 0 ? (
        <EmptyState icon={Users} title="No connections yet" message="Add the people you want to reach out to, with the message you plan to send each of them.">
          <Button variant="primary" onClick={() => setEditing("new")}>
            <UserPlus size={16} aria-hidden /> Add your first connection
          </Button>
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState icon={SearchX} title="No matching connections" message="Try a different search or status filter.">
          <Button
            onClick={() => {
              setQuery("");
              setStatus("");
            }}
          >
            Clear filters
          </Button>
        </EmptyState>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {visible.map((c) => (
            <ConnectionCard
              key={c.connectionId}
              c={c}
              mine={c.memberId === me}
              timeZone={timeZone}
              busy={busyId === c.connectionId}
              onStatus={(s) => changeStatus(c, s)}
              onEdit={() => setEditing(c)}
              onDelete={() => setDeleting(c)}
              onCopied={(ok) => setNotice(ok ? { kind: "success", text: "Message copied to the clipboard." } : { kind: "error", text: "Could not copy automatically. Select the message and copy it manually." })}
            />
          ))}
        </ul>
      )}

      {editing && (
        <Dialog title={editing === "new" ? "Add connection" : "Edit connection"} wide onClose={() => setEditing(null)}>
          <ConnectionForm connection={editing === "new" ? undefined : editing} onSaved={saved} onCancel={() => setEditing(null)} />
        </Dialog>
      )}

      {deleting && (
        <Dialog title="Remove connection?" onClose={() => setDeleting(null)}>
          <p className="text-sm">
            <strong>{deleting.name}</strong> and the saved message will be removed from your list. This does not affect anyone on LinkedIn.
          </p>
          <div className="mt-5 flex justify-end gap-3">
            <Button onClick={() => setDeleting(null)}>Keep</Button>
            <Button variant="danger" onClick={confirmDelete} disabled={busyId === deleting.connectionId}>
              <Trash2 size={16} aria-hidden /> Remove
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
