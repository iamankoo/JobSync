"use client";

import Link from "next/link";
import { useId, useMemo, useRef, useState } from "react";
import {
  ArrowRight, BarChart3, Briefcase, Calendar, CheckCircle2, ChevronDown, Clock, FileText, IndianRupee, Lightbulb,
  Link2, MapPin, Plus, RotateCcw,
} from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { CompanyMark } from "@/components/ui/company-mark";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { DESCRIPTION_MAX, EXPERIENCE_LEVELS } from "@/config/job-options";
import { createJobRequest } from "@/lib/client/api";
import { formatDisplayDate } from "@/lib/jobs/query";
import { createJobSchema } from "@/lib/validation/jobs";
import { JOB_TYPES, WORK_MODES, type Job } from "@/types/domain";

const FIELDS = ["jobRole", "company", "jobUrl", "location", "jobType", "experience", "stipendSalary", "deadline", "description", "workMode"] as const;
type FieldName = (typeof FIELDS)[number];
type Values = Record<FieldName, string>;

const EMPTY: Values = { jobRole: "", company: "", jobUrl: "", location: "", jobType: "", experience: "", stipendSalary: "", deadline: "", description: "", workMode: "" };
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

interface Props {
  recentJobs: Job[];
  /** Existing locations, offered as suggestions. */
  locations: string[];
  timeZone: string;
}

const inputBase =
  "h-12 w-full rounded-lg border bg-navy-950/60 pl-10 pr-3 text-sm text-ink outline-none transition placeholder:text-muted focus-visible:border-electric-soft";

function Field({
  id, label, required, error, children,
}: {
  id: string; label: string; required?: boolean; error?: string; children: React.ReactNode;
}) {
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

export function AddJobForm({ recentJobs, locations, timeZone }: Props) {
  const formId = useId();
  const [values, setValues] = useState<Values>(EMPTY);
  const [touched, setTouched] = useState<Set<FieldName>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [duplicate, setDuplicate] = useState<{ company: string; jobRole: string } | null>(null);
  const [recent, setRecent] = useState(recentJobs);
  const [knownLocations, setKnownLocations] = useState(locations);
  const topRef = useRef<HTMLDivElement>(null);

  const errors = useMemo(() => validateJobForm(values), [values]);
  const idOf = (f: FieldName) => `${formId}-${f}`;
  const errorFor = (f: FieldName) => ((submitted || touched.has(f)) && errors[f]) || serverErrors[f] || undefined;
  const aria = (f: FieldName) => ({ "aria-invalid": errorFor(f) ? true : undefined, "aria-describedby": errorFor(f) ? `${idOf(f)}-error` : undefined });

  function set(f: FieldName, value: string) {
    setValues((v) => ({ ...v, [f]: value }));
    setServerErrors((e) => (e[f] ? { ...e, [f]: undefined } : e));
    if (f === "jobUrl") setDuplicate(null);
  }
  const blur = (f: FieldName) => () => setTouched((t) => new Set(t).add(f));

  function clearAll() {
    setValues(EMPTY);
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
    // Identity (AddedBy) and timestamp are set by the server from the session; they are never sent.
    const res = await createJobRequest({
      company: values.company, jobRole: values.jobRole, jobType: values.jobType, workMode: values.workMode,
      experience: values.experience, stipendSalary: values.stipendSalary, location: values.location,
      jobUrl: values.jobUrl, deadline: values.deadline, description: values.description,
    });
    setBusy(false);

    if (res.ok) {
      const job = res.data;
      setRecent((r) => [job, ...r].slice(0, 5));
      setKnownLocations((l) => (l.includes(job.location) ? l : [...l, job.location].sort()));
      setValues(EMPTY);
      setTouched(new Set());
      setSubmitted(false);
      setServerErrors({});
      setNotice({ kind: "success", text: `Added "${job.jobRole}" at ${job.company}. It is now visible to everyone in All Jobs.` });
      topRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
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

  const border = (f: FieldName) => (errorFor(f) ? "border-red-500/70" : "border-line");

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div ref={topRef}>
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Add New Job</h1>
            <p className="mt-1 text-muted">Share a new job opportunity with the team</p>
          </div>
          <Link href="/all-jobs" className={buttonClass("secondary")}>
            View All Jobs <ArrowRight size={16} aria-hidden />
          </Link>
        </div>

        <form onSubmit={onSubmit} noValidate aria-label="Add a job" className="rounded-xl border border-line bg-navy-900/70 p-5 sm:p-6">
          <div className="mb-5 flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-lg bg-blue-600/80 text-white"><Briefcase size={22} aria-hidden /></span>
            <div>
              <h2 className="font-semibold">Job Details</h2>
              <p className="text-sm text-muted">Fill in the job information below</p>
            </div>
          </div>

          <div className="mb-4 space-y-3">
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

          <div className="mt-5">
            <Field id={idOf("description")} label="Job Description / Requirements" error={errorFor("description")}>
              <textarea id={idOf("description")} rows={4} value={values.description} onChange={(e) => set("description", e.target.value)} onBlur={blur("description")} maxLength={DESCRIPTION_MAX} placeholder="Add a short description about the role, responsibilities, or any important details…" className={`w-full rounded-lg border bg-navy-950/60 px-3 py-3 text-sm text-ink outline-none placeholder:text-muted focus-visible:border-electric-soft ${border("description")}`} {...aria("description")} />
              <p className="mt-1 text-right text-xs text-muted">{values.description.length}/{DESCRIPTION_MAX}</p>
            </Field>
          </div>

          <details id={`${formId}-more`} className="group mt-4 rounded-lg border border-line bg-navy-950/40">
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

          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Button onClick={clearAll} disabled={busy} className="h-12">
              <RotateCcw size={16} aria-hidden /> Clear
            </Button>
            <Button type="submit" variant="primary" disabled={busy} className="h-12">
              <Plus size={18} aria-hidden /> {busy ? "Adding…" : "Add Job"}
            </Button>
          </div>
        </form>
      </div>

      <aside className="space-y-6">
        <section aria-labelledby={`${formId}-tips`} className="rounded-xl border border-line bg-navy-900/70 p-5">
          <h2 id={`${formId}-tips`} className="mb-4 flex items-center gap-2 text-lg font-semibold">
            <Lightbulb size={20} className="text-violet-300" aria-hidden /> Tips for Adding a Job
          </h2>
          <ul className="space-y-3 text-sm text-ink/90">
            {[
              "Use the official job link from the company website or trusted sources.",
              "Add correct and complete information.",
              "Include stipend/salary if mentioned.",
              "Duplicate links are detected automatically, so each job is added once.",
              "Add any important details in the description.",
            ].map((tip) => (
              <li key={tip} className="flex gap-3">
                <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden />
                {tip}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby={`${formId}-recent`} className="rounded-xl border border-line bg-navy-900/70 p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id={`${formId}-recent`} className="flex items-center gap-2 text-lg font-semibold">
              <Clock size={20} className="text-violet-300" aria-hidden /> Recently Added Jobs
            </h2>
            <Link href="/all-jobs" className={buttonClass("secondary", "px-3 py-1.5")}>
              View All <ArrowRight size={14} aria-hidden />
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="text-sm text-muted">No jobs have been added yet. Jobs you add will show up here.</p>
          ) : (
            <ul className="divide-y divide-line/70">
              {recent.map((job) => (
                <li key={job.jobId} className="flex items-center gap-3 py-3">
                  <CompanyMark name={job.company} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{job.jobRole}</p>
                    <p className="truncate text-sm text-muted">{job.company} • {job.location}</p>
                  </div>
                  <span className="text-sm text-muted">{formatDisplayDate(job.addedAt, timeZone).slice(0, 6)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}
