"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { deleteJobRequest } from "@/lib/client/api";
import type { Job } from "@/types/domain";

interface Props {
  job: Job;
  onDeleted: (jobId: string) => void;
  onClose: () => void;
}

/** Asks for confirmation, then permanently deletes a job you added. */
export function DeleteJobDialog({ job, onDeleted, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await deleteJobRequest(job.jobId);
    setBusy(false);
    if (!res.ok) {
      // 404 means it is already gone (e.g. deleted from another tab): treat as done.
      if (res.status === 404) return onDeleted(job.jobId);
      return setError(res.message);
    }
    onDeleted(job.jobId);
  }

  return (
    <Dialog title="Delete this job?" onClose={onClose}>
      <p className="text-sm text-ink/90">
        <strong>{job.jobRole}</strong> at <strong>{job.company}</strong> will be permanently removed for everyone, together with any
        application records for it. This cannot be undone.
      </p>
      <p className="mt-2 text-sm text-muted">If you only need to fix a mistake, use Edit instead.</p>
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-3">
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" onClick={confirm} disabled={busy}>{busy ? "Deleting…" : "Delete job"}</Button>
      </div>
    </Dialog>
  );
}
