"use client";

import { useEffect, useState } from "react";
import { getMember } from "@/config/members";
import { apiRequest } from "@/lib/client/api";
import type { ConnectionDraftStatus, MailboxDraftStatus } from "@/lib/gmail/connection-draft";

const MAILBOX_LABEL: Record<MailboxDraftStatus, string> = {
  none: "waiting",
  created: "drafted",
  sent: "sent",
  skipped_unauthorized: "Gmail not connected",
  failed: "will retry",
  deleted: "draft deleted",
};

const HEADLINE: Record<ConnectionDraftStatus["state"], string> = {
  no_email: "No email address, so no Gmail drafts.",
  waiting: "Drafts will be created automatically within about 10 minutes.",
  drafting: "Drafting in progress",
  drafted: "Drafted",
};

/**
 * Read-only drafting state of a connection: drafts are created automatically in all three members' own Gmail
 * (never sent). Shows how many mailboxes have it, how many sent it, and each member's mailbox state.
 */
export function GmailDraftStatus({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<ConnectionDraftStatus | null | "error">(null);
  useEffect(() => {
    let live = true;
    apiRequest<ConnectionDraftStatus>(`/api/connections/${encodeURIComponent(connectionId)}/draft`).then((res) => {
      if (live) setData(res.ok ? res.data : "error");
    });
    return () => {
      live = false;
    };
  }, [connectionId]);

  return (
    <div className="mt-5 rounded-lg border border-line bg-navy-950/60 p-3" data-testid="gmail-draft-status">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Gmail drafts</h3>
      {data === null ? (
        <p className="mt-0.5 text-sm text-muted">Checking…</p>
      ) : data === "error" ? (
        <p className="mt-0.5 text-sm text-muted">Could not check the drafting status.</p>
      ) : (
        <>
          <p className="mt-0.5 text-sm" data-testid="gmail-draft-headline">
            {HEADLINE[data.state]}
            {(data.state === "drafted" || data.state === "drafting") && ` · ${data.drafted} of ${data.total} mailboxes${data.sent ? ` · ${data.sent} sent` : ""}${data.skipped ? ` · ${data.skipped} skipped` : ""}`}
          </p>
          {data.state !== "no_email" && (
            <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Draft per member mailbox">
              {data.members.map((m) => (
                <li key={m.memberId} data-testid={`gmail-draft-${m.memberId}`}>
                  {getMember(m.memberId)?.name ?? m.memberId}: <span className="text-ink/90">{MAILBOX_LABEL[m.status]}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="mt-1.5 text-xs text-muted">Saved as drafts in each member&apos;s own Gmail. JobSync never sends them.</p>
    </div>
  );
}
