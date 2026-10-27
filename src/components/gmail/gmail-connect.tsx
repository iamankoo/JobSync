"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button, buttonClass } from "@/components/ui/button";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { getMember } from "@/config/members";
import { apiRequest } from "@/lib/client/api";
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

/** Team connection status as small photos: connected in full, not connected dimmed. Never shows anyone else's address. */
function ConnectedMembers({ members }: { members: GmailOverview["members"] }) {
  return (
    <div className="flex items-center gap-2.5" data-testid="gmail-connected-members">
      <span className="text-sm font-medium text-muted">Connected:</span>
      <ul className="flex items-center -space-x-1.5">
        {members.map((m) => {
          const member = getMember(m.id);
          if (!member) return null;
          const label = `${member.name}: ${m.connected ? "Gmail connected" : "Gmail not connected"}`;
          return (
            <li key={m.id} title={label} data-connected={m.connected} className={`rounded-full border-2 border-navy-950 ${m.connected ? "" : "opacity-35 grayscale"}`}>
              <span role="img" aria-label={label} className="block">
                <Avatar member={member} size={30} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Connect / disconnect THIS member's Gmail. Other members appear only as connected or not. */
export function GmailConnect({ overview, justConnected, error }: { overview: GmailOverview; justConnected: boolean; error?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(
    justConnected ? { kind: "success", text: "Gmail connected. Network Finder can now save drafts in your Gmail (it never sends)." } : error ? { kind: "error", text: ERRORS[error] ?? "Gmail could not be connected." } : null,
  );
  const { me } = overview;
  const connected = me.status === "connected";
  const needsReconnect = me.status === "reauth_required";

  async function disconnect() {
    setBusy(true);
    // The server disconnects the SESSION member only; the request cannot name anyone else.
    const res = await apiRequest("/api/gmail/disconnect", { method: "POST" });
    setBusy(false);
    setConfirming(false);
    if (res.ok) {
      setNotice({ kind: "success", text: "Your Gmail was disconnected and JobSync's access revoked." });
      router.refresh();
    } else setNotice({ kind: "error", text: res.message });
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Gmail drafts</h1>
        <ConnectedMembers members={overview.members} />
      </div>
      <Notice notice={notice} onDismiss={() => setNotice(null)} />
      <section className="space-y-3 rounded-xl border border-line bg-navy-900/70 p-5">
        <div className="flex items-center gap-3">
          <Mail size={22} aria-hidden className="text-electric-soft" />
          <div className="min-w-0">
            <p className="font-semibold">Your Gmail</p>
            <p className="break-all text-sm text-muted" data-testid="gmail-my-status">
              {connected ? `Connected: ${me.email}` : needsReconnect ? `Needs reconnecting (${me.email})` : "Not connected"}
            </p>
          </div>
        </div>
        <p className="text-sm text-muted">
          Network Finder writes a personalised email for each new contact and saves it as a <strong className="text-ink">draft</strong> in your own Gmail.
          JobSync can only create drafts: it cannot read your mail and never sends anything. You review and send each one yourself.
        </p>
        {!overview.configured ? (
          <p className="text-sm text-amber-300">The server&apos;s Gmail settings are not configured yet.</p>
        ) : !overview.setUp ? (
          <p className="text-sm text-amber-300">The Network Finder tabs are not in the spreadsheet yet.</p>
        ) : confirming ? (
          <div role="group" aria-label="Confirm disconnect" className="space-y-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3">
            <p className="text-sm">
              Disconnect <strong className="break-all">{me.email || "your Gmail"}</strong>? Network Finder will stop saving drafts in your Gmail. Other members stay connected.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button variant="danger" onClick={disconnect} disabled={busy}>
                {busy ? "Disconnecting…" : "Yes, disconnect my Gmail"}
              </Button>
              <Button onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {/* A real navigation: the server redirects to Google's consent screen. */}
            <a href="/api/gmail/connect" className={buttonClass(connected ? "secondary" : "primary")}>
              {connected || needsReconnect ? "Reconnect Gmail" : "Connect Gmail"}
            </a>
            {(connected || needsReconnect) && (
              <Button onClick={() => setConfirming(true)}>
                Disconnect Gmail
              </Button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
