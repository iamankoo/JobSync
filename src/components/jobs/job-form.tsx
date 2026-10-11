"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { BarChart3, Briefcase, Calendar, ChevronDown, FileText, IndianRupee, Link2, MapPin, Plus, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { DESCRIPTION_MAX, EXPERIENCE_LEVELS } from "@/config/job-options";
import type { ApiResult } from "@/lib/client/api";
import { createJobSchema } from "@/lib/validation/jobs";
import { JOB_TYPES, WORK_MODES, type Job } from "@/types/domain";

export const FIELDS = ["jobRole", "company", "jobUrl", "location", "jobType", "experience", "stipendSalary", "deadline", "description", "workMode"] as const;
export type FieldName = (typeof FIELDS)[number];
export type Values = Record<FieldName, string>;

export const EMPTY_VALUES: Values = { jobRole: "", company: "", jobUrl: "", location: "", jobType: "", experience: "", stipendSalary: "", deadline: "", description: "", workMode: "" };
const REQUIRED: FieldName[] = ["jobRole", "company", "jobUrl", "location", "jobType", "experience"];
const REQUIRED_MESSAGE: Partial<Record<FieldName, string>> = {
  jobType: "Select a job type",
  experience: "Select an experience level",
};

/** Client-side validation with the SAME schema the server enforces (the server remains the authority). */
export function validateJobForm(values: Values): Partial<Record<FieldName, string>> {
  const errors: Partial<Record<FieldName, string>> = {};
  for (const f of REQUIRED) {
    if (values[f].trim() === "") errors[f] = REQUIRED_MESSAGE[f] ?? "This field is required";
  }
  const parsed = createJobSchema.safeParse({ ...values, experience: values.experience || undefined });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as FieldName | undefined;
      if (field && !errors[field]) errors[field] = issue.message;
    }
  }
  return errors;
}

/** Form values for an existing job (used to pre-fill the edit dialog). */
export function valuesFromJob(job: Job): Values {
  return {
    jobRole: job.jobRole,
    company: job.company,
    jobUrl: job.jobUrl,
    location: job.location,
    jobType: job.jobType,
    experience: job.experience ?? "",
    stipendSalary: job.stipendSalary ?? "",
    deadline: job.deadline ?? "",
    description: job.description ?? "",
    workMode: job.workMode ?? "",
  };
}

const inputBase =
  "h-12 w-full rounded-lg border bg-navy-950/60 pl-10 pr-3 text-sm text-ink outline-none transition placeholder:text-muted focus-visible:border-electric-soft";

function Field({ id, label, required, error, children }: { id: string; label: string; required?: boolean; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
        {label} {required && <span aria-hidden className="text-red-400">*</span>}
        {!required && <span className="font-normal text-muted"> (optional)</span>}
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

function Shell({ icon: Icon, error, children }: { icon: typeof Link2; error?: string; children: React.ReactNode }) {
  return (
    <div className={`relative rounded-lg ${error ? "ring-1 ring-red-500/70" : ""}`}>
      <Icon size={17} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 text-electric-soft" />
      {children}
    </div>
  );
}

interface Props {
  mode: "create" | "edit";
  initialValues?: Values;
  /** Existing locations, offered as suggestions. */
  locations: string[];
  /** Sends the job to the server (POST for create, PUT for edit). */
  submit: (body: Record<string, unknown>) => Promise<ApiResult<Job>>;
  onSuccess: (job: Job) => void;
  /** Edit mode only: closes the dialog. */
  onCancel?: () => void;
  /** Create mode only: text of the confirmation shown after a successful add. */
  successText?: (job: Job) => string;
}

export function JobForm({ mode, initialValues, locations, submit, onSuccess, onCancel, successText }: Props) {
  const formId = useId();
  const start = initialValues ?? EMPTY_VALUES;
  const [values, setValues] = useState<Values>(start);
  const [touched, setTouched] = useState<Set<FieldName>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [duplicate, setDuplicate] = useState<{ company: string; jobRole: string } | null>(null);
  const [knownLocations, setKnownLocations] = useState(locations);

  const errors = useMemo(() => validateJobForm(values), [values]);
  const idOf = (f: FieldName) => `${formId}-${f}`;
  const errorFor = (f: FieldName) => ((submitted || touched.has(f)) && errors[f]) || serverErrors[f] || undefined;
  const aria = (f: FieldName) => ({ "aria-invalid": errorFor(f) ? true : undefined, "aria-describedby": errorFor(f) ? `${idOf(f)}-error` : undefined });
  const border = (f: FieldName) => (errorFor(f) ? "border-red-500/70" : "border-line");

  function set(f: FieldName, value: string) {
    setValues((v) => ({ ...v, [f]: value }));
    setServerErrors((e) => (e[f] ? { ...e, [f]: undefined } : e));
    if (f === "jobUrl") setDuplicate(null);
  }
  const blur = (f: FieldName) => () => setTouched((t) => new Set(t).add(f));

  function clearAll() {
    setValues(start);
    setTouched(new Set());
    setSubmitted(false);
    setServerErrors({});
    setNotice(null);
    setDuplicate(null);
    document.getElementById(idOf("jobRole"))?.focus();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setNotice(null);
    setDuplicate(null);

    const firstInvalid = FIELDS.find((f) => errors[f]);
    if (firstInvalid) {
      if (firstInvalid === "workMode") (document.getElementById(`${formId}-more`) as HTMLDetailsElement | null)?.setAttribute("open", "");
      document.getElementById(idOf(firstInvalid))?.focus();
      return;
    }

    setBusy(true);
    // Identity (AddedBy), IDs and timestamps are never sent: the server owns them.
    const res = await submit({
      company: values.company, jobRole: values.jobRole, jobType: values.jobType, workMode: values.workMode,
      experience: values.experience, stipendSalary: values.stipendSalary, location: values.location,
      jobUrl: values.jobUrl, deadline: values.deadline, description: values.description,
    });
    setBusy(false);

    if (res.ok) {
      const job = res.data;
      setKnownLocations((l) => (l.includes(job.location) ? l : [...l, job.location].sort()));
      if (mode === "create") {
        setValues(EMPTY_VALUES);
        setTouched(new Set());
        setSubmitted(false);
        setServerErrors({});
        setNotice({ kind: "success", text: successText ? successText(job) : "Job saved." });
      }
      onSuccess(job);
      return;
    }

    if (res.status === 409 && res.code === "duplicate_url") {
      const d = res.details as { company?: string; jobRole?: string } | undefined;
      setDuplicate({ company: d?.company ?? "another company", jobRole: d?.jobRole ?? "this role" });
      setServerErrors({ jobUrl: "This job link has already been added." });
      document.getElementById(idOf("jobUrl"))?.focus();
      return;
    }
    if (res.status === 400 && res.details && typeof (res.details as { fields?: unknown }).fields === "object") {
      const fields = (res.details as { fields: Record<string, string> }).fields;
      const mapped: Partial<Record<FieldName, string>> = {};
      for (const [k, msg] of Object.entries(fields)) if ((FIELDS as readonly string[]).includes(k)) mapped[k as FieldName] = msg;
      setServerErrors(mapped);
      setNotice({ kind: "error", text: "Please fix the highlighted fields." });
      return;
    }
    setNotice({ kind: "error", text: res.message });
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label={mode === "create" ? "Add a job" : "Edit job"} className="space-y-5">
      <div className="space-y-3 empty:hidden">
        <Notice notice={notice} onDismiss={() => setNotice(null)} />
        {duplicate && (
          <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            Already added: <strong>{duplicate.jobRole}</strong> at <strong>{duplicate.company}</strong> uses this link.{" "}
            <Link href={`/all-jobs?q=${encodeURIComponent(duplicate.company)}`} className="underline">Find it in All Jobs</Link>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-x-5 gap-y-5 md:grid-cols-2">
        <Field id={idOf("jobRole")} label="Job Title" required error={errorFor("jobRole")}>
          <Shell icon={FileText} error={errorFor("jobRole")}>
            <input id={idOf("jobRole")} value={values.jobRole} onChange={(e) => set("jobRole", e.target.value)} onBlur={blur("jobRole")} placeholder="e.g. Software Engineer, Data Analyst" maxLength={160} aria-required className={`${inputBase} ${border("jobRole")}`} {...aria("jobRole")} />
          </Shell>
        </Field>
        <Field id={idOf("company")} label="Company" required error={errorFor("company")}>
          <Shell icon={Briefcase} error={errorFor("company")}>
            <input id={idOf("company")} value={values.company} onChange={(e) => set("company", e.target.value)} onBlur={blur("company")} placeholder="e.g. company name" maxLength={120} aria-required className={`${inputBase} ${border("company")}`} {...aria("company")} />
          </Shell>
        </Field>
        <Field id={idOf("jobUrl")} label="Job Link" required error={errorFor("jobUrl")}>
          <Shell icon={Link2} error={errorFor("jobUrl")}>
            <input id={idOf("jobUrl")} type="url" inputMode="url" value={values.jobUrl} onChange={(e) => set("jobUrl", e.target.value)} onBlur={blur("jobUrl")} placeholder="https://" aria-required className={`${inputBase} ${border("jobUrl")}`} {...aria("jobUrl")} />
          </Shell>
        </Field>
        <Field id={idOf("location")} label="Location" required error={errorFor("location")}>
          <Shell icon={MapPin} error={errorFor("location")}>
            <input id={idOf("location")} list={`${formId}-locations`} value={values.location} onChange={(e) => set("location", e.target.value)} onBlur={blur("location")} placeholder="e.g. Bangalore, Remote" maxLength={120} aria-required autoComplete="off" className={`${inputBase} ${border("location")}`} {...aria("location")} />
          </Shell>
          <datalist id={`${formId}-locations`}>
            {[...new Set(["Remote", ...knownLocations])].map((l) => <option key={l} value={l} />)}
          </datalist>
        </Field>
        <Field id={idOf("jobType")} label="Job Type" required error={errorFor("jobType")}>
          <Shell icon={Briefcase} error={errorFor("jobType")}>
            <select id={idOf("jobType")} value={values.jobType} onChange={(e) => set("jobType", e.target.value)} onBlur={blur("jobType")} aria-required className={`${inputBase} ${border("jobType")} appearance-none`} {...aria("jobType")}>
              <option value="">Select job type</option>
              {JOB_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <ChevronDown size={16} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
          </Shell>
        </Field>
        <Field id={idOf("experience")} label="Experience Level" required error={errorFor("experience")}>
          <Shell icon={BarChart3} error={errorFor("experience")}>
            <select id={idOf("experience")} value={values.experience} onChange={(e) => set("experience", e.target.value)} onBlur={blur("experience")} aria-required className={`${inputBase} ${border("experience")} appearance-none`} {...aria("experience")}>
              <option value="">Select experience level</option>
              {/* Keep an existing value (e.g. typed by hand in the sheet) selectable when editing. */}
              {values.experience && !(EXPERIENCE_LEVELS as readonly string[]).includes(values.experience) && <option value={values.experience}>{values.experience}</option>}
              {EXPERIENCE_LEVELS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <ChevronDown size={16} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
          </Shell>
        </Field>
        <Field id={idOf("stipendSalary")} label="Stipend / Salary" error={errorFor("stipendSalary")}>
          <Shell icon={IndianRupee} error={errorFor("stipendSalary")}>
            <input id={idOf("stipendSalary")} value={values.stipendSalary} onChange={(e) => set("stipendSalary", e.target.value)} onBlur={blur("stipendSalary")} placeholder="e.g. ₹20–40 LPA, ₹30K / month, Not disclosed" maxLength={80} className={`${inputBase} ${border("stipendSalary")}`} {...aria("stipendSalary")} />
          </Shell>
        </Field>
        <Field id={idOf("deadline")} label="Application Deadline" error={errorFor("deadline")}>
          <Shell icon={Calendar} error={errorFor("deadline")}>
            <input id={idOf("deadline")} type="date" value={values.deadline} onChange={(e) => set("deadline", e.target.value)} onBlur={blur("deadline")} className={`${inputBase} ${border("deadline")} [color-scheme:dark]`} {...aria("deadline")} />
          </Shell>
        </Field>
      </div>

      <Field id={idOf("description")} label="Job Description / Requirements" error={errorFor("description")}>
        <textarea id={idOf("description")} rows={4} value={values.description} onChange={(e) => set("description", e.target.value)} onBlur={blur("description")} maxLength={DESCRIPTION_MAX} placeholder="Add a short description about the role, responsibilities, or any important details…" className={`w-full rounded-lg border bg-navy-950/60 px-3 py-3 text-sm text-ink outline-none placeholder:text-muted focus-visible:border-electric-soft ${border("description")}`} {...aria("description")} />
        <p className="mt-1 text-right text-xs text-muted">{values.description.length}/{DESCRIPTION_MAX}</p>
      </Field>

      <details id={`${formId}-more`} open={mode === "edit" && values.workMode !== ""} className="group rounded-lg border border-line bg-navy-950/40">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4">
          <span>
            <span className="block font-semibold">Additional Information (Optional)</span>
            <span className="block text-sm text-muted">Add more details if available</span>
          </span>
          <ChevronDown size={18} aria-hidden className="transition group-open:rotate-180" />
        </summary>
        <div className="px-4 pb-4">
          <Field id={idOf("workMode")} label="Work Mode" error={errorFor("workMode")}>
            <Shell icon={MapPin}>
              <select id={idOf("workMode")} value={values.workMode} onChange={(e) => set("workMode", e.target.value)} className={`${inputBase} ${border("workMode")} appearance-none`} {...aria("workMode")}>
                <option value="">Not specified</option>
                {WORK_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <ChevronDown size={16} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
            </Shell>
          </Field>
        </div>
      </details>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {mode === "create" ? (
          <Button onClick={clearAll} disabled={busy} className="h-12">
            <RotateCcw size={16} aria-hidden /> Clear
          </Button>
        ) : (
          <Button onClick={onCancel} disabled={busy} className="h-12">
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={busy} className="h-12">
          {mode === "create" ? <Plus size={18} aria-hidden /> : <Save size={18} aria-hidden />}
          {busy ? (mode === "create" ? "Adding…" : "Saving…") : mode === "create" ? "Add Job" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
