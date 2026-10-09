"use client";

import { useId, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { updateApplication, type ApplicationUpdate } from "@/lib/client/api";
import { ALLOWED_TRANSITIONS } from "@/lib/validation/applications";
import { APPLICATION_STAGES, type ApplicationStage, type ApplicationStatus, type MyApplicationRow } from "@/types/domain";

interface Props {
  row: MyApplicationRow;
  onClose: () => void;
  onSaved: (result: ApplicationUpdate) => void;
}

const field =
  "mt-1.5 h-11 w-full rounded-lg border border-line bg-navy-950/60 px-3 text-sm text-ink outline-none focus-visible:border-electric-soft";

/** Edits the signed-in member's OWN application. Only transitions the server allows are offered. */
export function ApplicationUpdateDialog({ row, onClose, onSaved }: Props) {
  const id = useId();
  const { job, application } = row;
  const [status, setStatus] = useState<ApplicationStatus>(application.status);
  const [stage, setStage] = useState<string>(application.applicationStage ?? "");
  const [notes, setNotes] = useState(application.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets: ApplicationStatus[] = [application.status, ...ALLOWED_TRANSITIONS[application.status]];
  const undoing = status === "Not Applied";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await updateApplication(job.jobId, {
      status,
      applicationStage: undoing || !stage ? null : (stage as ApplicationStage),
      notes: notes.trim() === "" ? null : notes.trim(),
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    onSaved(res.data);
  }

  return (
    <Dialog title="Update application" onClose={onClose}>
      <p className="text-sm text-muted">
        {job.jobRole} at {job.company}
      </p>
      <form onSubmit={save} className="mt-4 space-y-4">
        <div>
          <label htmlFor={`${id}-status`} className="text-sm font-medium">Status</label>
          <select id={`${id}-status`} value={status} onChange={(e) => setStatus(e.target.value as ApplicationStatus)} className={field}>
            {targets.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {undoing && (
            <p className="mt-1.5 text-sm text-amber-300">This moves the job back to Not Applied and removes it from My Applications.</p>
          )}
        </div>
        <div>
          <label htmlFor={`${id}-stage`} className="text-sm font-medium">Stage <span className="font-normal text-muted">(optional)</span></label>
          <select id={`${id}-stage`} value={undoing ? "" : stage} disabled={undoing} onChange={(e) => setStage(e.target.value)} className={`${field} disabled:opacity-50`}>
            <option value="">No stage</option>
            {APPLICATION_STAGES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-notes`} className="text-sm font-medium">Notes <span className="font-normal text-muted">(private to you)</span></label>
          <textarea
            id={`${id}-notes`}
            rows={4}
            maxLength={1000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-line bg-navy-950/60 px-3 py-2.5 text-sm text-ink outline-none focus-visible:border-electric-soft"
          />
          <p className="mt-1 text-right text-xs text-muted">{notes.length}/1000</p>
        </div>
        {error && (
          <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
