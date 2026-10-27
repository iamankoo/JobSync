"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { MEMBERS, type MemberId } from "@/config/members";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { apiRequest } from "@/lib/client/api";

/** Administrator (Anni) only: reset a member's Profile Password. The old password is never shown, only cleared. */
export function AdminReset({ me, onSelfReset }: { me: MemberId; onSelfReset: () => void }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<MemberId | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  async function reset(id: MemberId) {
    setBusy(true);
    const res = await apiRequest<{ memberId: MemberId }>("/api/profile/admin/reset", { method: "POST", body: JSON.stringify({ memberId: id }) });
    setBusy(false);
    setTarget(null);
    const name = MEMBERS.find((m) => m.id === id)?.name ?? id;
    if (!res.ok) return setNotice({ kind: "error", text: res.message });
    if (id === me) return onSelfReset();
    setNotice({ kind: "success", text: `${name}'s Profile Password was reset. ${name} will set a new one next time.` });
  }

  return (
    <section aria-labelledby="admin-reset-heading" className="space-y-3 rounded-xl border border-line bg-navy-900/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="admin-reset-heading" className="font-semibold">Admin</h2>
        <Button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <KeyRound size={16} aria-hidden /> Reset Passwords
        </Button>
      </div>
      {open && (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Members">
          {MEMBERS.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <Avatar member={m} size={32} />
              <span className="flex-1 font-medium">{m.name}</span>
              {target === m.id ? (
                <span className="flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm reset for ${m.name}`}>
                  <span className="text-sm text-muted">Reset {m.name}&apos;s password?</span>
                  <Button variant="danger" className="px-3 py-1.5" onClick={() => reset(m.id)} disabled={busy}>Confirm reset</Button>
                  <Button className="px-3 py-1.5" onClick={() => setTarget(null)} disabled={busy}>Cancel</Button>
                </span>
              ) : (
                <Button className="px-3 py-1.5" onClick={() => setTarget(m.id)} disabled={busy} aria-label={`Reset ${m.name}'s password`}>Reset</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Notice notice={notice} onDismiss={() => setNotice(null)} />
    </section>
  );
}
