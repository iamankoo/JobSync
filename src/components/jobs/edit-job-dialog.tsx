"use client";

import { Dialog } from "@/components/ui/dialog";
import { updateJobRequest } from "@/lib/client/api";
import type { Job } from "@/types/domain";
import { JobForm, valuesFromJob } from "./job-form";

interface Props {
  job: Job;
  locations: string[];
  onSaved: (job: Job) => void;
  onClose: () => void;
}

/** Edits a job you added. The server re-checks ownership and validation; nothing here is trusted. */
export function EditJobDialog({ job, locations, onSaved, onClose }: Props) {
  return (
    <Dialog title="Edit job" onClose={onClose} wide>
      <JobForm
        mode="edit"
        initialValues={valuesFromJob(job)}
        locations={locations}
        submit={(body) => updateJobRequest(job.jobId, body)}
        onSuccess={onSaved}
        onCancel={onClose}
      />
    </Dialog>
  );
}
