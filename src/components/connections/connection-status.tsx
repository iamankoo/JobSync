"use client";

import { CONNECTION_STATUSES, type Connection, type ConnectionStatus } from "@/types/domain";

export const STATUS_STYLE: Record<ConnectionStatus, string> = {
  "Not Connected": "border-slate-500/40 bg-slate-500/15 text-slate-200",
  Connected: "border-blue-500/40 bg-blue-500/15 text-blue-200",
  Messaged: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  Reply: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
};

export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  return <span className={`inline-block whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-semibold ${STATUS_STYLE[status]}`}>{status}</span>;
}

/** The adder changes the status right here; everyone else sees it as a badge (only the adder may edit). */
export function ConnectionStatusControl({ c, mine, busy, onStatus }: { c: Connection; mine: boolean; busy: boolean; onStatus: (s: ConnectionStatus) => void }) {
  if (!mine) return <ConnectionStatusBadge status={c.status} />;
  return (
    <select
      value={c.status}
      disabled={busy}
      onChange={(e) => onStatus(e.target.value as ConnectionStatus)}
      aria-label={`Status of ${c.name}`}
      className={`h-9 rounded-md border px-2 text-xs font-semibold outline-none hover:border-electric-soft focus-visible:border-electric-soft disabled:opacity-60 ${STATUS_STYLE[c.status]}`}
    >
      {CONNECTION_STATUSES.map((s) => (
        <option key={s} value={s} className="bg-navy-900 text-ink">
          {s}
        </option>
      ))}
    </select>
  );
}
