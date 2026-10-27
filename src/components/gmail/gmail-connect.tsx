"use client";

import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { getMember } from "@/config/members";
import type { GmailOverview } from "@/lib/gmail/overview";

const ERRORS: Record<string, string> = {
  denied: "Google access was not granted. Nothing was connected.",
  invalid_state: "That sign-in link expired or did not match this browser. Please try again.",
  scope_missing: "Permission to create drafts was not ticked on Google's screen. Please connect again and allow it.",
  no_refresh_token: "Google did not grant offline access. Remove JobSync under myaccount.google.com → Security → Third-party access, then connect again.",
  token_exchange_failed: "Google did not accept the sign-in. Please try again.",
  not_configured: "Gmail connection is not set up on the server yet (OAuth settings missing).",
  not_set_up: "The NF_GmailAccounts tab does not exist in the spreadsheet yet.",
  member_inactive: "This member is not active.",
  signed_out: "Your JobSync session ended. Sign in and try again.",
  unavailable: "Google or the spreadsheet could not be reached. Please try again.",
};

/** Photos of the members whose Gmail is connected right now (from the server; never anyone's address). */
function ConnectedMembers({ members }: { members: GmailOverview["members"] }) {
  const connected = members.filter((m) => m.connected).map((m) => getMember(m.id)).filter((m) => m !== undefined);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2.5" data-testid="gmail-connected-members">
      <span className="text-sm font-medium text-muted">Connected:</span>
      {connected.length === 0 ? (
        <span className="text-sm text-muted">No one yet</span>
      ) : (
        <ul className="flex items-center -space-x-1.5" aria-label="Members with Gmail connected">
          {connected.map((member) => (
            <li key={member.id} title={member.name} className="rounded-full border-2 border-navy-950">
              <span role="img" aria-label={`${member.name}: Gmail connected`} className="block">
                <Avatar member={member} size={32} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Gmail Drafts page: the title and who is connected. Each member connects, reconnects or disconnects their own
 * Gmail from Profile → Gmail; Google sends them back here, so the outcome of a connect is shown as a notice.
 */
export function GmailConnect({ members, justConnected, error }: { members: GmailOverview["members"]; justConnected: boolean; error?: string }) {
  const [notice, setNotice] = useState<NoticeState | null>(
    justConnected ? { kind: "success", text: "Gmail connected. Network Finder can now save drafts in your Gmail (it never sends)." } : error ? { kind: "error", text: ERRORS[error] ?? "Gmail could not be connected." } : null,
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h1 className="text-xl font-semibold">Gmail drafts</h1>
        <ConnectedMembers members={members} />
      </div>
      <Notice notice={notice} onDismiss={() => setNotice(null)} />
    </div>
  );
}
