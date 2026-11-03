"use client";

import { useId, useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createManualConnectionSchema, EMAIL_MAX, updateConnectionSchema } from "@/lib/validation/connections";
import { createConnectionRequest, updateConnectionRequest } from "@/lib/client/api";
import { CUSTOM_ROLE_MAX, isRoleCategory, suggestApplyRole } from "@/lib/connections/apply-role";
import { RolePicker } from "./role-picker";
import { roleForConnection } from "@/lib/network-finder/connection-role";
import type { Connection } from "@/types/domain";

/**
 * The six things a member enters: Person Name*, Person Designation, Person Email*, Company Name*, Company URL, Role to Apply*
 * (a category plus the final role, so two controls). Add and Edit are this same component. Historical fields (message, notes,
 * profile links) are not editable here and are never sent, so saving an old record leaves them untouched.
 */
type Field = "name" | "role" | "email" | "company" | "companyUrl" | "roleCategory" | "applyRole";
type Values = Record<Field, string>;

const EMPTY: Values = { name: "", role: "", email: "", company: "", companyUrl: "", roleCategory: "", applyRole: "" };

/** An old record has no Role to Apply: what its notes said is offered as a starting point only (nothing is saved until the member saves). */
function legacySuggestion(c: Connection) {
  const reading = roleForConnection({ notes: c.notes, message: c.message });
  return reading.status === "found" ? suggestApplyRole(reading.role.title) : null;
}

function fromConnection(c: Connection): { values: Values; suggested: boolean } {
  const base: Values = { name: c.name, role: c.role ?? "", email: c.email ?? "", company: c.company ?? "", companyUrl: c.companyUrl ?? "", roleCategory: c.roleCategory ?? "", applyRole: c.applyRole ?? "" };
  if (c.roleCategory && c.applyRole) return { values: base, suggested: false };
  const s = legacySuggestion(c);
  return s ? { values: { ...base, roleCategory: s.category, applyRole: s.role }, suggested: true } : { values: { ...base, roleCategory: "", applyRole: "" }, suggested: false };
}

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
  const initial = connection ? fromConnection(connection) : { values: EMPTY, suggested: false };
  const [values, setValues] = useState<Values>(initial.values);
  const [suggested, setSuggested] = useState(initial.suggested);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = (f: Field) => `${uid}-${f}`;
  const set = (f: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setValues((v) => ({ ...v, [f]: e.target.value }));
  const aria = (f: Field) => ({ id: id(f), "aria-invalid": errors[f] ? true : undefined, "aria-describedby": errors[f] ? `${id(f)}-error` : undefined });
  const category = isRoleCategory(values.roleCategory) ? values.roleCategory : "";

  /** Picking a role (or Other) replaces the pair; a different category always clears the previous role. */
  function pickRole(next: { category: string; role: string }) {
    setSuggested(false);
    setValues((v) => ({ ...v, roleCategory: next.category, applyRole: next.role }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    // Only these seven keys are ever sent: old records keep their historical message / notes / links.
    const body = { name: values.name, role: values.role, email: values.email, company: values.company, companyUrl: values.companyUrl, roleCategory: values.roleCategory, applyRole: values.applyRole };
    const parsed = connection ? updateConnectionSchema.safeParse(body) : createManualConnectionSchema.safeParse(body);
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
    const res = connection ? await updateConnectionRequest(connection.connectionId, body) : await createConnectionRequest(body);
    setBusy(false);
    if (res.ok) return onSaved(res.data);
    const fields = (res.details?.fields ?? null) as Record<string, string> | null;
    if (fields) setErrors(fields as Partial<Record<Field, string>>);
    setFormError(res.message);
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Labeled id={id("name")} label="Person Name" required error={errors.name}>
          <input {...aria("name")} value={values.name} onChange={set("name")} maxLength={120} autoComplete="off" placeholder="e.g. Priya Sharma" className={`${input} h-11`} />
        </Labeled>
        <Labeled id={id("role")} label="Person Designation" error={errors.role}>
          <input {...aria("role")} value={values.role} onChange={set("role")} maxLength={120} autoComplete="off" placeholder="e.g. Engineering Manager" className={`${input} h-11`} />
        </Labeled>
        <Labeled id={id("email")} label="Person Email" required error={errors.email}>
          <input {...aria("email")} type="email" value={values.email} onChange={set("email")} maxLength={EMAIL_MAX} inputMode="email" autoComplete="off" placeholder="e.g. priya@acme.com" className={`${input} h-11`} />
        </Labeled>
        <Labeled id={id("company")} label="Company Name" required error={errors.company}>
          <input {...aria("company")} value={values.company} onChange={set("company")} maxLength={120} autoComplete="off" placeholder="e.g. Acme Corp" className={`${input} h-11`} />
        </Labeled>
        <Labeled id={id("companyUrl")} label="Company URL" error={errors.companyUrl}>
          <input {...aria("companyUrl")} value={values.companyUrl} onChange={set("companyUrl")} inputMode="url" autoComplete="off" placeholder="https://acme.com" className={`${input} h-11`} />
        </Labeled>
        <div>
          <span id={`${uid}-role-label`} className="mb-1.5 block text-sm font-medium">
            Role to Apply <span aria-hidden className="text-red-400">*</span>
          </span>
          <RolePicker
            id={id("roleCategory")}
            labelId={`${uid}-role-label`}
            category={values.roleCategory}
            role={category === "Other" ? "" : values.applyRole}
            invalid={Boolean(errors.roleCategory || (category !== "Other" && errors.applyRole))}
            describedBy={errors.roleCategory ? `${id("roleCategory")}-error` : errors.applyRole ? `${id("applyRole")}-error` : undefined}
            onChange={pickRole}
          />
          {category === "Other" && (
            <input {...aria("applyRole")} aria-label="Custom role" value={values.applyRole} onChange={set("applyRole")} maxLength={CUSTOM_ROLE_MAX} autoComplete="off" placeholder="Type the role, e.g. Site Reliability Engineer" className={`${input} mt-2 h-11`} />
          )}
          {errors.roleCategory && <p id={`${id("roleCategory")}-error`} className="mt-1.5 text-sm text-red-300">{errors.roleCategory}</p>}
          {errors.applyRole && <p id={`${id("applyRole")}-error`} className="mt-1.5 text-sm text-red-300">{errors.applyRole}</p>}
          {suggested && <p className="mt-1.5 text-xs text-muted" data-testid="role-suggestion">Suggested from this connection&apos;s earlier notes. Check it, then save.</p>}
        </div>
      </div>
      {formError && (
        <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
          {formError}
        </p>
      )}
      <div className="flex items-center justify-between gap-3 pt-1">
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
