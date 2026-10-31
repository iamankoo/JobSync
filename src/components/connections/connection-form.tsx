"use client";

import { useId, useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createConnectionRequest, updateConnectionRequest } from "@/lib/client/api";
import { createConnectionSchema, EMAIL_MAX, MESSAGE_MAX, NOTES_MAX } from "@/lib/validation/connections";
import { CONNECTION_STATUSES, type Connection } from "@/types/domain";

type Field = "name" | "company" | "role" | "email" | "profileUrl" | "otherUrl" | "message" | "notes" | "status";
type Values = Record<Field, string>;

const EMPTY: Values = { name: "", company: "", role: "", email: "", profileUrl: "", otherUrl: "", message: "", notes: "", status: "Not Connected" };

const fromConnection = (c: Connection): Values => ({
  name: c.name, company: c.company ?? "", role: c.role ?? "", email: c.email ?? "", profileUrl: c.profileUrl ?? "", otherUrl: c.otherUrl ?? "",
  message: c.message ?? "", notes: c.notes ?? "", status: c.status,
});

const input = "w-full rounded-lg border border-line bg-navy-950/60 px-3 text-sm text-ink outline-none transition placeholder:text-muted focus-visible:border-electric-soft";

function Labeled({ id, label, required, error, children }: { id: string; label: string; required?: boolean; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label} {required ? <span aria-hidden className="text-red-400">*</span> : <span className="font-normal text-muted">(optional)</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

/** Create / edit form. Validated with the SAME schema the server enforces (the server stays the authority). */
export function ConnectionForm({ connection, onSaved, onCancel }: { connection?: Connection; onSaved: (c: Connection) => void; onCancel: () => void }) {
  const uid = useId();
  const [values, setValues] = useState<Values>(connection ? fromConnection(connection) : EMPTY);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = (f: Field) => `${uid}-${f}`;
  const set = (f: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setValues((v) => ({ ...v, [f]: e.target.value }));
  const aria = (f: Field) => ({ id: id(f), "aria-invalid": errors[f] ? true : undefined, "aria-describedby": errors[f] ? `${id(f)}-error` : undefined });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const parsed = createConnectionSchema.safeParse(values);
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const f = issue.path[0] as Field | undefined;
        if (f && !next[f]) next[f] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setFormError(null);
    setBusy(true);
    const res = connection ? await updateConnectionRequest(connection.connectionId, values) : await createConnectionRequest(values);
    setBusy(false);
    if (res.ok) return onSaved(res.data);
    const fields = (res.details?.fields ?? null) as Record<string, string> | null;
    if (fields) setErrors(fields as Partial<Record<Field, string>>);
    setFormError(res.message);
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Labeled id={id("name")} label="Person's name" required error={errors.name}>
          <input {...aria("name")} value={values.name} onChange={set("name")} maxLength={120} autoComplete="off" placeholder="e.g. Priya Sharma" className={`${input} h-11`} />
        </Labeled>
        <Labeled id={id("company")} label="Company" error={errors.company}>
          <input {...aria("company")} value={values.company} onChange={set("company")} maxLength={120} autoComplete="off" placeholder="e.g. Acme Corp" className={`${input} h-11`} />
        </Labeled>
        <Labeled id={id("role")} label="Role / designation" error={errors.role}>
          <input {...aria("role")} value={values.role} onChange={set("role")} maxLength={120} autoComplete="off" placeholder="e.g. Engineering Manager" className={`${input} h-11`} />
        </Labeled>
        <Labeled id={id("email")} label="Email" error={errors.email}>
          <input {...aria("email")} type="email" value={values.email} onChange={set("email")} maxLength={EMAIL_MAX} inputMode="email" autoComplete="off" placeholder="e.g. priya@acme.com" className={`${input} h-11`} />
        </Labeled>
        {/* New connections start as "Not Connected"; the status is changed later (here when editing, or from the details). */}
        {connection && (
          <Labeled id={id("status")} label="Status" required error={errors.status}>
            <select {...aria("status")} value={values.status} onChange={set("status")} className={`${input} h-11`}>
              {CONNECTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Labeled>
        )}
        <Labeled id={id("profileUrl")} label="LinkedIn / profile URL" error={errors.profileUrl}>
          <input {...aria("profileUrl")} value={values.profileUrl} onChange={set("profileUrl")} inputMode="url" autoComplete="off" placeholder="https://www.linkedin.com/in/…" className={`${input} h-11`} />
        </Labeled>
        <Labeled id={id("otherUrl")} label="Other profile / contact URL" error={errors.otherUrl}>
          <input {...aria("otherUrl")} value={values.otherUrl} onChange={set("otherUrl")} inputMode="url" autoComplete="off" placeholder="https://… (portfolio, GitHub, contact page)" className={`${input} h-11`} />
        </Labeled>
      </div>
      <Labeled id={id("message")} label="Message to send" error={errors.message}>
        <textarea {...aria("message")} value={values.message} onChange={set("message")} rows={5} maxLength={MESSAGE_MAX} placeholder="Hi …, I came across your profile and would love to connect…" className={`${input} resize-y py-2.5`} />
        <p className="mt-1 text-xs text-muted">{values.message.length}/{MESSAGE_MAX}. JobSync never sends this anywhere: copy it and send it yourself.</p>
      </Labeled>
      <Labeled id={id("notes")} label="Notes" error={errors.notes}>
        <textarea {...aria("notes")} value={values.notes} onChange={set("notes")} rows={3} maxLength={NOTES_MAX} placeholder="Role: the job you are asking about (e.g. Role: Machine Learning Engineer), plus where you met, referral hints…" className={`${input} resize-y py-2.5`} />
      </Labeled>
      {formError && (
        <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
          {formError}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3 pt-1">
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          <Save size={16} aria-hidden />
          {busy ? "Saving…" : connection ? "Save changes" : "Add connection"}
        </Button>
      </div>
    </form>
  );
}
