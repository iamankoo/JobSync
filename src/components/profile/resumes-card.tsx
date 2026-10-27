"use client";

import { useRef, useState } from "react";
import { Download, ExternalLink, FileText, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { apiRequest } from "@/lib/client/api";
import { formatBytes } from "@/lib/chat/files";
import type { ResumeInfo } from "@/lib/google-sheets/member-files-service";
import { MAX_RESUMES, PROFILE_MAX_BYTES, RESUME_ACCEPT, RESUME_TYPES } from "@/lib/profile/uploads";
import { uploadFile } from "./upload";

/** ONE card with all of the signed-in member's resumes: upload (+), open, download, delete. Limit enforced on the server too. */
export function ResumesCard({ initial, timeZone = "UTC" }: { initial: ResumeInfo[] | null; timeZone?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [resumes, setResumes] = useState<ResumeInfo[]>(initial ?? []);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const enabled = initial !== null;
  const full = resumes.length >= MAX_RESUMES;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > PROFILE_MAX_BYTES) return setNotice({ kind: "error", text: `Resumes can be at most ${formatBytes(PROFILE_MAX_BYTES)}.` });
    setBusy(true);
    const res = await uploadFile<ResumeInfo>("/api/profile/resumes", file);
    setBusy(false);
    if (res.ok) {
      setResumes((r) => [res.data, ...r]);
      setNotice({ kind: "success", text: `Uploaded ${res.data.fileName}.` });
    } else setNotice({ kind: "error", text: res.message });
  }

  async function remove(r: ResumeInfo) {
    setBusy(true);
    const res = await apiRequest<{ recordId: string }>(`/api/profile/resumes/${encodeURIComponent(r.recordId)}`, { method: "DELETE" });
    setBusy(false);
    setConfirmId(null);
    if (res.ok) {
      setResumes((list) => list.filter((x) => x.recordId !== r.recordId));
      setNotice({ kind: "success", text: `Deleted ${r.fileName}.` });
    } else setNotice({ kind: "error", text: res.message });
  }

  return (
    <section aria-labelledby="resumes-heading" className="space-y-3 rounded-xl border border-line bg-navy-900/70 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="resumes-heading" className="font-semibold">My Resumes</h2>
          <p className="text-sm text-muted" data-testid="resume-count">{resumes.length} / {MAX_RESUMES} resumes</p>
        </div>
        {enabled && (
          <>
            <input ref={inputRef} id="resume-input" type="file" accept={RESUME_ACCEPT} onChange={onPick} className="sr-only" aria-hidden tabIndex={-1} disabled={busy || full} />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy || full}
              aria-label={full ? `Resume limit reached (${MAX_RESUMES})` : "Upload a resume"}
              title={full ? `You have ${MAX_RESUMES} resumes. Delete one to upload another.` : "Upload a resume"}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent-strong text-on-accent transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={22} aria-hidden />
            </button>
          </>
        )}
      </div>
      {!enabled ? (
        <p className="text-sm text-amber-300">Uploads are not set up yet (the MemberFiles tab is missing).</p>
      ) : (
        <p className="text-xs text-muted">
          {full ? "Limit reached: delete a resume to upload another." : `${Object.values(RESUME_TYPES).join(", ")}, up to ${formatBytes(PROFILE_MAX_BYTES)} each. Only you can see them.`}
        </p>
      )}
      <Notice notice={notice} onDismiss={() => setNotice(null)} />
      {enabled && resumes.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Your resumes">
          {resumes.map((r) => {
            const href = `/api/profile/resumes/${encodeURIComponent(r.recordId)}`;
            return (
              <li key={r.recordId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <FileText size={20} aria-hidden className="shrink-0 text-electric-soft" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={r.fileName}>{r.fileName}</p>
                  <p className="text-xs text-muted">
                    {RESUME_TYPES[r.mimeType] ?? "File"} · {formatBytes(r.sizeBytes)} · Uploaded {new Date(r.uploadedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone })}
                  </p>
                </div>
                {confirmId === r.recordId ? (
                  <div className="flex items-center gap-2" role="group" aria-label={`Confirm deleting ${r.fileName}`}>
                    <Button variant="danger" className="px-3 py-1.5" onClick={() => remove(r)} disabled={busy}>Delete</Button>
                    <Button className="px-3 py-1.5" onClick={() => setConfirmId(null)} disabled={busy}>Cancel</Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    {r.mimeType === "application/pdf" && (
                      <a href={href} target="_blank" rel="noopener" aria-label={`Open ${r.fileName}`} title="Open" className="rounded-lg p-2 text-muted hover:bg-navy-800 hover:text-ink">
                        <ExternalLink size={18} aria-hidden />
                      </a>
                    )}
                    <a href={`${href}?download=1`} download={r.fileName} aria-label={`Download ${r.fileName}`} title="Download" className="rounded-lg p-2 text-muted hover:bg-navy-800 hover:text-ink">
                      <Download size={18} aria-hidden />
                    </a>
                    <button type="button" onClick={() => setConfirmId(r.recordId)} disabled={busy} aria-label={`Delete ${r.fileName}`} title="Delete" className="rounded-lg p-2 text-muted hover:bg-navy-800 hover:text-red-300">
                      <Trash2 size={18} aria-hidden />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
