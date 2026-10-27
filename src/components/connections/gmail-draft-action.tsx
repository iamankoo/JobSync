"use client";

import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { apiRequest } from "@/lib/client/api";

type Status = "none" | "created" | "sent" | "failed" | "skipped_unauthorized" | "deleted";

/**
 * "Create Gmail Draft" for the signed-in member's OWN connection with an email: shown when no draft exists yet,
 * as "Retry" after a failed attempt, and as a note once the draft exists. The server enforces ownership and
 * never duplicates or sends anything.
 */
export function GmailDraftAction({ connectionId, name }: { connectionId: string; name: string }) {
  const [status, setStatus] = useState<Status | "loading" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  useEffect(() => {
    let live = true;
    apiRequest<{ status: Status; hasEmail: boolean }>(`/api/connections/${encodeURIComponent(connectionId)}/draft`).then((res) => {
      if (live) setStatus(res.ok ? res.data.status : "error");
    });
    return () => {
      live = false;
    };
  }, [connectionId]);

  async function create() {
    setBusy(true);
    setNotice(null);
    const res = await apiRequest<{ result: "created" | "already_drafted"; message: string }>(`/api/connections/${encodeURIComponent(connectionId)}/draft`, { method: "POST" });
    setBusy(false);
    if (res.ok) {
      setStatus("created");
      setNotice({ kind: "success", text: res.data.message });
    } else {
      if (res.code === "draft_failed") setStatus("failed");
      setNotice({ kind: "error", text: res.message });
    }
  }

  const exists = status === "created" || status === "sent";
  return (
    <div className="mt-5 rounded-lg border border-line bg-navy-950/60 p-3" data-testid="gmail-draft-action">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Gmail draft</h3>
          <p className="mt-0.5 text-sm" data-testid="gmail-draft-state">
            {status === "loading"
              ? "Checking…"
              : status === "error"
                ? "Could not check the draft status."
                : status === "sent"
                  ? "Sent from your Gmail."
                  : status === "created"
                    ? "Draft already exists in your Gmail."
                    : status === "failed"
                      ? "The last attempt failed."
                      : "No draft in your Gmail yet."}
          </p>
        </div>
        {!exists && status !== "loading" && (
          <Button variant="primary" onClick={create} disabled={busy} aria-label={`${status === "failed" ? "Retry" : "Create"} Gmail draft for ${name}`}>
            <Mail size={16} aria-hidden />
            {busy ? "Creating…" : status === "failed" ? "Retry Gmail Draft" : "Create Gmail Draft"}
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">Saved as a draft in your own Gmail only. JobSync never sends it.</p>
      {notice && (
        <div className="mt-3">
          <Notice notice={notice} onDismiss={() => setNotice(null)} />
        </div>
      )}
    </div>
  );
}
