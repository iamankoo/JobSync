"use client";

import { useState } from "react";
import { Mail, Send } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { CompanyMark } from "@/components/ui/company-mark";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { cellClass, HEAD_ROW_CLASS, ROW_CLASS, TABLE_CLASS, TBODY_CLASS, THEAD_CLASS, TH_CLASS } from "@/components/ui/responsive-table";
import { getMember } from "@/config/members";
import type { DraftList, DraftListItem, DraftListStatus } from "@/lib/gmail/draft-list";
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

/** Draft / Sent counts of the member's own Network Finder drafts. */
function SummaryCard({ label, value, icon: Icon, tone }: { label: string; value: number; icon: typeof Mail; tone: string }) {
  return (
    <div className="flex min-w-[8.5rem] flex-1 items-center gap-3 rounded-xl border border-line bg-navy-900/70 px-4 py-2.5 sm:flex-none" data-testid={`gmail-count-${label.toLowerCase()}`}>
      <Icon size={20} aria-hidden className={tone} />
      <span className="text-sm text-muted">{label}</span>
      <span className="ml-auto text-xl font-bold tabular-nums" aria-label={`${value} ${label.toLowerCase()}`}>{value}</span>
    </div>
  );
}

const STATUS_BADGE: Record<DraftListStatus, string> = {
  Drafted: "bg-amber-500/20 text-amber-200",
  Sent: "bg-emerald-600/30 text-emerald-300",
};

function DraftsTable({ items }: { items: DraftListItem[] }) {
  const dash = (v: string) => v || "—";
  return (
    <section aria-label="Your Network Finder drafts" className="rounded-xl border border-line bg-navy-900/70">
      <div className="relative overflow-x-auto">
        <table role="table" className={TABLE_CLASS}>
          <caption className="sr-only">Your Network Finder drafts, newest first</caption>
          <thead role="rowgroup" className={THEAD_CLASS}>
            <tr role="row" className={HEAD_ROW_CLASS}>
              {["Company", "Person", "Designation", "Email", "Status"].map((h) => (
                <th role="columnheader" key={h} scope="col" className={TH_CLASS}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup" className={TBODY_CLASS}>
            {items.map((d) => (
              <tr role="row" key={d.draftKey} className={ROW_CLASS} data-testid="gmail-draft-row">
                <td role="cell" data-label="Company" className={cellClass("font-medium", "title")}>
                  <span className="flex items-center gap-2">{d.company && <CompanyMark name={d.company} size={26} />}{dash(d.company)}</span>
                </td>
                <td role="cell" data-label="Person" className={cellClass("")}>{dash(d.person)}</td>
                <td role="cell" data-label="Designation" className={cellClass("")}>{dash(d.designation)}</td>
                <td role="cell" data-label="Email" className={cellClass("break-all")}>{dash(d.email)}</td>
                <td role="cell" data-label="Status" className={cellClass("whitespace-nowrap")}>
                  <span className={`inline-block rounded-md px-3 py-1 text-xs font-semibold ${STATUS_BADGE[d.status]}`}>{d.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Gmail Drafts page: the title, the member's own Draft / Sent counts, who is connected, and the member's own
 * Network Finder drafts (from the real draft ledger; a draft becomes "Sent" once the sent-draft tracker sees it sent).
 * Each member connects, reconnects or disconnects their own Gmail from Profile → Gmail; Google sends them back here,
 * so the outcome of a connect is shown as a notice.
 */
export function GmailConnect({ members, drafts, justConnected, error }: { members: GmailOverview["members"]; drafts: DraftList; justConnected: boolean; error?: string }) {
  const [notice, setNotice] = useState<NoticeState | null>(
    justConnected ? { kind: "success", text: "Gmail connected. Network Finder can now save drafts in your Gmail (it never sends)." } : error ? { kind: "error", text: ERRORS[error] ?? "Gmail could not be connected." } : null,
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <h1 className="text-xl font-semibold">Gmail drafts</h1>
        <div className="flex w-full flex-wrap gap-3 sm:w-auto" aria-label="Draft and sent counts" role="group">
          <SummaryCard label="Draft" value={drafts.drafted} icon={Mail} tone="text-amber-300" />
          <SummaryCard label="Sent" value={drafts.sent} icon={Send} tone="text-emerald-300" />
        </div>
        <div className="ml-auto">
          <ConnectedMembers members={members} />
        </div>
      </div>
      <Notice notice={notice} onDismiss={() => setNotice(null)} />
      {drafts.items.length === 0 ? (
        <EmptyState icon={Mail} title="Drafts are coming soon" message="Your personalized Network Finder emails will appear here once drafts are created." />
      ) : (
        <DraftsTable items={drafts.items} />
      )}
    </div>
  );
}
