"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera } from "lucide-react";
import type { Member } from "@/config/members";
import { Avatar } from "@/components/ui/avatar";
import { buttonClass } from "@/components/ui/button";
import { useUploadedPhoto } from "@/components/ui/member-photos";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { formatBytes } from "@/lib/chat/files";
import { PHOTO_ACCEPT, PHOTO_TYPES, PROFILE_MAX_BYTES } from "@/lib/profile/uploads";
import { uploadFile } from "./upload";

/** The signed-in member's professional photo: preview, upload, replace. The built-in photo stays until one is uploaded. */
export function PhotoCard({ member, enabled }: { member: Member; enabled: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploaded = useUploadedPhoto(member.id);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > PROFILE_MAX_BYTES) return setNotice({ kind: "error", text: `Photos can be at most ${formatBytes(PROFILE_MAX_BYTES)}.` });
    setBusy(true);
    const res = await uploadFile<{ version: string }>("/api/profile/photo", file);
    setBusy(false);
    if (res.ok) {
      setNotice({ kind: "success", text: uploaded ? "Photo replaced." : "Photo uploaded. It now appears wherever JobSync shows you." });
      router.refresh(); // the layout re-reads photo versions, so every avatar updates
    } else setNotice({ kind: "error", text: res.message });
  }

  return (
    <section aria-labelledby="photo-heading" className="space-y-3 rounded-xl border border-line bg-navy-900/70 p-5">
      <h2 id="photo-heading" className="font-semibold">Professional Photo</h2>
      <div className="flex flex-wrap items-center gap-4">
        <div data-testid="profile-photo-preview" data-uploaded={Boolean(uploaded)}>
          <Avatar member={member} size={88} ring />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-muted">
            Your avatar everywhere in JobSync. {uploaded ? "Your uploaded photo is shown to the team." : "You are using the default JobSync photo."} JPEG, PNG or WebP, up to {formatBytes(PROFILE_MAX_BYTES)}.
          </p>
          {enabled ? (
            <>
              <input ref={inputRef} id="profile-photo-input" type="file" accept={PHOTO_ACCEPT} onChange={onPick} className="sr-only" aria-hidden tabIndex={-1} disabled={busy} />
              <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className={buttonClass("secondary")}>
                <Camera size={16} aria-hidden />
                {busy ? "Uploading…" : uploaded ? "Replace photo" : "Upload photo"}
              </button>
            </>
          ) : (
            <p className="text-sm text-amber-300">Uploads are not set up yet (the MemberFiles tab is missing).</p>
          )}
        </div>
      </div>
      <Notice notice={notice} onDismiss={() => setNotice(null)} />
      <p className="sr-only">Allowed types: {Object.values(PHOTO_TYPES).join(", ")}.</p>
    </section>
  );
}
