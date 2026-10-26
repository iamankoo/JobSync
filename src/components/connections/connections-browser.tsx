"use client";

import { useState } from "react";
import { Eye, Plus, Trash2, UserPlus, Users } from "lucide-react";
import { ActionMenu } from "@/components/ui/action-menu";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CompanyMark } from "@/components/ui/company-mark";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { cellClass, HEAD_ROW_CLASS, ROW_CLASS, TABLE_CLASS, TBODY_CLASS, TH_CLASS, THEAD_CLASS } from "@/components/ui/responsive-table";
import { getMember, type MemberId } from "@/config/members";
import { deleteConnectionRequest, updateConnectionRequest } from "@/lib/client/api";
import { formatDisplayDate } from "@/lib/jobs/query";
import type { Connection, ConnectionStatus } from "@/types/domain";
import { ConnectionDetailsDialog } from "./connection-details-dialog";
import { ConnectionForm } from "./connection-form";

/** The SHARED people-to-connect-with list (everyone sees everything; only the adder edits). Tracking only: nothing is ever sent to LinkedIn or anyone else. */
export function ConnectionsBrowser({ connections: initial, me, timeZone }: { connections: Connection[]; me: MemberId; timeZone: string }) {
  const [items, setItems] = useState(initial);
  const [seen, setSeen] = useState(initial);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [deleting, setDeleting] = useState<Connection | null>(null);
  // By id, so the open details always show the latest saved values (status changes, background refresh).
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  // Fresh data from the background refresh replaces the list.
  if (initial !== seen) {
    setSeen(initial);
    setItems(initial);
  }

  const viewing = viewingId ? items.find((c) => c.connectionId === viewingId) ?? null : null;
  const copiedNotice = (ok: boolean) =>
    setNotice(ok ? { kind: "success", text: "Message copied to the clipboard." } : { kind: "error", text: "Could not copy automatically. Select the message and copy it manually." });

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
    <div className="space-y-3">
      {/* Just the title and the Add button: the list starts right below. */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Connections</h1>
        <Button variant="primary" onClick={() => setEditing("new")} className="h-10 py-0">
          <Plus size={16} aria-hidden /> Add connection
        </Button>
      </div>

      <Notice notice={notice} onDismiss={() => setNotice(null)} />

      {items.length === 0 ? (
        <EmptyState icon={Users} title="No connections yet" message="Add the people you want to reach out to, with the message you plan to send each of them.">
          <Button variant="primary" onClick={() => setEditing("new")}>
            <UserPlus size={16} aria-hidden /> Add your first connection
          </Button>
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-navy-900/70">
          <div className="relative overflow-x-auto">
            <table role="table" className={TABLE_CLASS} data-testid="connections-list">
              <caption className="sr-only">Shared connections</caption>
              <thead role="rowgroup" className={THEAD_CLASS}>
                <tr role="row" className={HEAD_ROW_CLASS}>
                  <th role="columnheader" scope="col" className={TH_CLASS}>#</th>
                  <th role="columnheader" scope="col" className={TH_CLASS}>Name</th>
                  <th role="columnheader" scope="col" className={TH_CLASS}>Company</th>
                  <th role="columnheader" scope="col" className={TH_CLASS}>Role / Title</th>
                  <th role="columnheader" scope="col" className={TH_CLASS}>Email</th>
                  <th role="columnheader" scope="col" className={TH_CLASS}>Added by</th>
                  <th role="columnheader" scope="col" className={TH_CLASS}>Added on</th>
                  <th role="columnheader" scope="col" className={TH_CLASS}>Actions</th>
                </tr>
              </thead>
              <tbody role="rowgroup" className={TBODY_CLASS}>
                {items.map((c, i) => {
                  const mine = c.memberId === me;
                  const adder = getMember(c.memberId);
                  return (
                    <tr role="row" key={c.connectionId} className={ROW_CLASS} data-testid="connection-row">
                      <td role="cell" data-label="#" className={cellClass("text-muted", "index")}>{i + 1}</td>
                      <td role="cell" data-label="Name" className={cellClass("font-medium", "title")}>
                        <button type="button" onClick={() => setViewingId(c.connectionId)} className="break-words text-left hover:text-electric-soft hover:underline">
                          {c.name}
                        </button>
                      </td>
                      <td role="cell" data-label="Company" className={cellClass("")}>
                        {c.company ? (
                          <span className="flex min-w-0 items-center gap-2">
                            <CompanyMark name={c.company} />
                            <span className="min-w-0 break-words">{c.company}</span>
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td role="cell" data-label="Role / Title" className={cellClass("")}>
                        {c.role ? <span className="min-w-0 break-words max-xl:text-right">{c.role}</span> : <span className="text-muted">—</span>}
                      </td>
                      <td role="cell" data-label="Email" className={cellClass("")}>
                        {c.email ? (
                          <a href={`mailto:${c.email}`} className="min-w-0 break-all text-electric-soft hover:underline max-xl:text-right" data-testid="connection-row-email">
                            {c.email}
                          </a>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td role="cell" data-label="Added by" className={cellClass("whitespace-nowrap")}>
                        {adder ? (
                          <span className="flex items-center gap-2" data-testid="connection-row-added-by">
                            <Avatar member={adder} size={22} />
                            <span style={{ color: adder.accentText }}>{mine ? "You" : adder.name}</span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td role="cell" data-label="Added on" className={cellClass("whitespace-nowrap")}>
                        <time dateTime={c.createdAt}>{formatDisplayDate(c.createdAt, timeZone)}</time>
                      </td>
                      <td role="cell" data-label="Actions" className={cellClass("")}>
                        <span className="flex items-center gap-2">
                          <Button onClick={() => setViewingId(c.connectionId)} className="h-9 px-3 py-0" aria-label={`View ${c.name}`}>
                            <Eye size={16} aria-hidden /> View
                          </Button>
                          {mine && (
                            <ActionMenu
                              label={`More actions: ${c.name}`}
                              items={[
                                { label: "Edit connection", onSelect: () => setEditing(c) },
                                { label: "Delete connection", onSelect: () => setDeleting(c) },
                              ]}
                            />
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="border-t border-line px-4 py-3 text-sm text-muted">
            {items.length} connection{items.length === 1 ? "" : "s"}
          </p>
        </div>
      )}

      {viewing && (
        <ConnectionDetailsDialog
          c={viewing}
          mine={viewing.memberId === me}
          timeZone={timeZone}
          busy={busyId === viewing.connectionId}
          onStatus={(s) => changeStatus(viewing, s)}
          onEdit={() => {
            setViewingId(null);
            setEditing(viewing);
          }}
          onDelete={() => {
            setViewingId(null);
            setDeleting(viewing);
          }}
          onCopied={copiedNotice}
          onClose={() => setViewingId(null)}
        />
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
