"use client";

import Link from "next/link";
import { useState } from "react";
import { Mail } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { apiRequest } from "@/lib/client/api";
import type { UnlockedProfile } from "@/lib/profile/unlocked";

/** The member's own Gmail connection, with Disconnect (the same server route as the Gmail Drafts page: own account only). */
export function GmailCard({ gmail }: { gmail: UnlockedProfile["gmail"] }) {
  const [status, setStatus] = useState(gmail.status);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const connected = status === "connected" || status === "reauth_required";

  async function disconnect() {
    setBusy(true);
    const res = await apiRequest("/api/gmail/disconnect", { method: "POST" });
    setBusy(false);
    setConfirming(false);
    if (res.ok) {
      setStatus("not_connected");
      setNotice({ kind: "success", text: "Your Gmail was disconnected and JobSync's access revoked." });
    } else setNotice({ kind: "error", text: res.message });
  }

  return (
    <section aria-labelledby="profile-gmail-heading" className="space-y-3 rounded-xl border border-line bg-navy-900/70 p-5">
      <div className="flex items-center gap-3">
        <Mail size={20} aria-hidden className="text-electric-soft" />
        <div className="min-w-0">
          <h2 id="profile-gmail-heading" className="font-semibold">Gmail</h2>
          <p className="break-all text-sm text-muted" data-testid="profile-gmail-status">{connected ? `Connected: ${gmail.email ?? ""}` : "Not connected"}</p>
        </div>
      </div>
      {confirming ? (
        <div role="group" aria-label="Confirm disconnect" className="flex flex-wrap items-center gap-3">
          <span className="text-sm">Disconnect your Gmail? Other members stay connected.</span>
          <Button variant="danger" onClick={disconnect} disabled={busy}>{busy ? "Disconnecting…" : "Yes, disconnect my Gmail"}</Button>
          <Button onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {connected && <Button onClick={() => setConfirming(true)}>Disconnect Gmail</Button>}
          <Link href="/gmail" className={buttonClass(connected ? "ghost" : "secondary")}>{connected ? "Gmail Drafts page" : "Connect on the Gmail Drafts page"}</Link>
        </div>
      )}
      <Notice notice={notice} onDismiss={() => setNotice(null)} />
    </section>
  );
}
