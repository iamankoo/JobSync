"use client";

import { useId, useState } from "react";
import { Save } from "lucide-react";
import type { Member } from "@/config/members";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { apiRequest } from "@/lib/client/api";
import type { ResumeInfo } from "@/lib/google-sheets/member-files-service";
import type { Profile } from "@/lib/google-sheets/profile-service";
import type { UnlockedProfile } from "@/lib/profile/unlocked";
import { AdminReset } from "./admin-reset";
import { GmailCard } from "./gmail-card";
import { PhotoCard } from "./photo-card";
import { ResumesCard } from "./resumes-card";
import { EMAIL_MAX } from "@/lib/validation/connections";
import { PROFILE_HANDLE_MAX, profileSchema } from "@/lib/validation/profile";

type Field = "name" | "linkedin" | "github" | "email" | "mobile";
type Values = Record<Field, string>;

const FIELDS: { key: Field; label: string; placeholder: string; type?: string; inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]; autoComplete: string; max: number }[] = [
  { key: "name", label: "Name", placeholder: "Your full name", autoComplete: "name", max: 120 },
  { key: "linkedin", label: "LinkedIn ID or profile URL", placeholder: "e.g. your-id or https://www.linkedin.com/in/your-id", inputMode: "url", autoComplete: "off", max: PROFILE_HANDLE_MAX },
  { key: "github", label: "GitHub ID or profile URL", placeholder: "e.g. your-id or https://github.com/your-id", inputMode: "url", autoComplete: "off", max: PROFILE_HANDLE_MAX },
  { key: "email", label: "Email", placeholder: "you@example.com", type: "email", inputMode: "email", autoComplete: "email", max: EMAIL_MAX },
  { key: "mobile", label: "Mobile number", placeholder: "e.g. +91 98765 43210", type: "tel", inputMode: "tel", autoComplete: "tel", max: 20 },
];

const input = "h-11 w-full rounded-lg border border-line bg-navy-950/60 px-3 text-sm text-ink outline-none transition placeholder:text-muted focus-visible:border-electric-soft";

const pick = (p: Profile): Values => ({ name: p.name, linkedin: p.linkedin, github: p.github, email: p.email, mobile: p.mobile });

interface Props {
  member: Member;
  profile: Profile;
  resumes?: ResumeInfo[] | null;
  gmail?: UnlockedProfile["gmail"];
  /** Anni (administrator): shows Reset Passwords. */
  isAdmin?: boolean;
  onSelfReset?: () => void;
  timeZone?: string;
}

/** The unlocked Profile: the member edits their own details (validated with the SAME schema the server enforces). */
export function ProfileForm({ member, profile, resumes = null, gmail, isAdmin = false, onSelfReset = () => undefined, timeZone = "UTC" }: Props) {
  const uid = useId();
  const [values, setValues] = useState<Values>(pick(profile));
  const [saved, setSaved] = useState<Values>(pick(profile));
  const [updatedAt, setUpdatedAt] = useState(profile.updatedAt);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = FIELDS.some((f) => values[f.key].trim() !== saved[f.key]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const parsed = profileSchema.safeParse(values);
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const f = issue.path[0] as Field | undefined;
        if (f && !next[f]) next[f] = issue.message;
      }
      setErrors(next);
      setNotice(null);
      return;
    }
    setErrors({});
    setBusy(true);
    const res = await apiRequest<Profile>("/api/profile", { method: "PUT", body: JSON.stringify(parsed.data) });
    setBusy(false);
    if (res.ok) {
      setValues(pick(res.data));
      setSaved(pick(res.data));
      setUpdatedAt(res.data.updatedAt);
      setNotice({ kind: "success", text: "Profile saved." });
    } else {
      const fields = (res.details?.fields ?? null) as Partial<Record<Field, string>> | null;
      if (fields) setErrors(fields);
      setNotice({ kind: "error", text: res.message });
    }
  }

  return (
    <div className="w-full space-y-5">
      <div className="flex items-center gap-4">
        <Avatar member={member} size={64} ring />
        <div>
          <h1 className="text-3xl font-bold">Profile</h1>
          <p className="mt-1 text-muted">Your details. Only you can see and edit them in JobSync.</p>
        </div>
      </div>

      <form onSubmit={submit} noValidate className="space-y-4 rounded-xl border border-line bg-navy-900/70 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((f) => {
            const id = `${uid}-${f.key}`;
            return (
              <div key={f.key} className={f.key === "name" ? "sm:col-span-2" : ""}>
                <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{f.label}</label>
                <input
                  id={id}
                  name={f.key}
                  type={f.type ?? "text"}
                  inputMode={f.inputMode}
                  autoComplete={f.autoComplete}
                  maxLength={f.max}
                  value={values[f.key]}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [f.key]: e.target.value }));
                    setNotice(null);
                  }}
                  placeholder={f.placeholder}
                  aria-invalid={errors[f.key] ? true : undefined}
                  aria-describedby={errors[f.key] ? `${id}-error` : undefined}
                  className={input}
                />
                {errors[f.key] && <p id={`${id}-error`} className="mt-1.5 text-sm text-red-300">{errors[f.key]}</p>}
              </div>
            );
          })}
        </div>
        <Notice notice={notice} onDismiss={() => setNotice(null)} />
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-xs text-muted" data-testid="profile-updated">
            {updatedAt ? `Last updated ${new Date(updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone })}` : "Not saved yet"}
          </p>
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            <Save size={16} aria-hidden />
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>

      <PhotoCard member={member} enabled={resumes !== null} />
      <ResumesCard initial={resumes} timeZone={timeZone} />
      {gmail && <GmailCard gmail={gmail} />}
      {isAdmin && <AdminReset me={member.id} onSelfReset={onSelfReset} />}
    </div>
  );
}
