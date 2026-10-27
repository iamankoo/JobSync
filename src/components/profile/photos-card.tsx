"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { Download, ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { apiRequest } from "@/lib/client/api";
import { formatBytes } from "@/lib/chat/files";
import type { LibraryPhotoInfo } from "@/lib/google-sheets/member-files-service";
import { MAX_LIBRARY_PHOTOS, PHOTO_ACCEPT, PROFILE_MAX_BYTES } from "@/lib/profile/uploads";
import { uploadFile } from "./upload";

/**
 * ONE card with the member's private Photos library (separate from the Professional Photo / avatar): add (+), view,
 * download, delete. Same rules and server checks as resumes; images load only with an unlocked Profile.
 */
export function PhotosCard({ initial, timeZone = "UTC" }: { initial: LibraryPhotoInfo[] | null; timeZone?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<LibraryPhotoInfo[]>(initial ?? []);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const enabled = initial !== null;
  const full = photos.length >= MAX_LIBRARY_PHOTOS;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > PROFILE_MAX_BYTES) return setNotice({ kind: "error", text: `Photos can be at most ${formatBytes(PROFILE_MAX_BYTES)}.` });
    setBusy(true);
    const res = await uploadFile<LibraryPhotoInfo>("/api/profile/photos", file);
    setBusy(false);
    if (res.ok) {
      setPhotos((p) => [res.data, ...p]);
      setNotice({ kind: "success", text: `Added ${res.data.fileName} to Photos. Your profile photo is unchanged.` });
    } else setNotice({ kind: "error", text: res.message });
  }

  async function remove(p: LibraryPhotoInfo) {
    setBusy(true);
    const res = await apiRequest<{ recordId: string }>(`/api/profile/photos/${encodeURIComponent(p.recordId)}`, { method: "DELETE" });
    setBusy(false);
    setConfirmId(null);
    if (res.ok) {
      setPhotos((list) => list.filter((x) => x.recordId !== p.recordId));
      setNotice({ kind: "success", text: `Deleted ${p.fileName}.` });
    } else setNotice({ kind: "error", text: res.message });
  }

  return (
    <section aria-labelledby="photos-heading" className="space-y-3 rounded-xl border border-line bg-navy-900/70 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="photos-heading" className="font-semibold">Photos</h2>
          <p className="text-sm text-muted" data-testid="photo-count">{photos.length} / {MAX_LIBRARY_PHOTOS} photos</p>
        </div>
        {enabled && (
          <>
            <input ref={inputRef} id="library-photo-input" type="file" accept={PHOTO_ACCEPT} onChange={onPick} className="sr-only" aria-hidden tabIndex={-1} disabled={busy || full} />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy || full}
              aria-label={full ? `Photo limit reached (${MAX_LIBRARY_PHOTOS})` : "Add Photo"}
              title={full ? `You have ${MAX_LIBRARY_PHOTOS} photos. Delete one to add another.` : "Add Photo"}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent-strong px-4 py-2 text-sm font-semibold text-on-accent transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={18} aria-hidden /> {busy ? "Adding…" : "Add Photo"}
            </button>
          </>
        )}
      </div>
      <p className="text-xs text-muted">
        {!enabled
          ? "Uploads are not set up yet (the MemberFiles tab is missing)."
          : full
            ? "Limit reached: delete a photo to add another."
            : `Your private photo library. Separate from your profile photo — adding or deleting here never changes your avatar. JPEG, PNG or WebP, up to ${formatBytes(PROFILE_MAX_BYTES)} each. Only you can see them.`}
      </p>
      <Notice notice={notice} onDismiss={() => setNotice(null)} />
      {enabled && photos.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Your photos">
          {photos.map((p) => {
            const href = `/api/profile/photos/${encodeURIComponent(p.recordId)}`;
            return (
              <li key={p.recordId} className="overflow-hidden rounded-lg border border-line bg-navy-950/40" data-testid="library-photo">
                <a href={href} target="_blank" rel="noopener" aria-label={`View ${p.fileName}`} className="block aspect-square bg-navy-800">
                  {/* Served by an authenticated route, so it bypasses the image optimiser (which would fetch without the session). */}
                  <Image src={href} alt={p.fileName} width={240} height={240} unoptimized className="h-full w-full object-cover" />
                </a>
                <div className="space-y-1.5 p-2">
                  <p className="truncate text-xs font-medium" title={p.fileName}>{p.fileName}</p>
                  <p className="text-[11px] text-muted">
                    {formatBytes(p.sizeBytes)} · {new Date(p.uploadedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone })}
                  </p>
                  {confirmId === p.recordId ? (
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Confirm deleting ${p.fileName}`}>
                      <Button variant="danger" className="px-2.5 py-1 text-xs" onClick={() => remove(p)} disabled={busy}>Delete</Button>
                      <Button className="px-2.5 py-1 text-xs" onClick={() => setConfirmId(null)} disabled={busy}>Cancel</Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <a href={href} target="_blank" rel="noopener" aria-label={`Open ${p.fileName}`} title="View" className="rounded-md p-1.5 text-muted hover:bg-navy-800 hover:text-ink">
                        <ExternalLink size={16} aria-hidden />
                      </a>
                      <a href={`${href}?download=1`} download={p.fileName} aria-label={`Download ${p.fileName}`} title="Download" className="rounded-md p-1.5 text-muted hover:bg-navy-800 hover:text-ink">
                        <Download size={16} aria-hidden />
                      </a>
                      <button type="button" onClick={() => setConfirmId(p.recordId)} disabled={busy} aria-label={`Delete ${p.fileName}`} title="Delete" className="rounded-md p-1.5 text-muted hover:bg-navy-800 hover:text-red-300">
                        <Trash2 size={16} aria-hidden />
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
