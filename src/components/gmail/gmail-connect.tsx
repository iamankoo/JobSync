"use client";

import { useEffect, useState } from "react";
import { Mail, Send } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { CompanyMark } from "@/components/ui/company-mark";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice, type NoticeState } from "@/components/ui/notice";
import { cellClass, HEAD_ROW_CLASS, ROW_CLASS, TABLE_CLASS, TBODY_CLASS, THEAD_CLASS, TH_CLASS } from "@/components/ui/responsive-table";
import { getMember } from "@/config/members";
import type { DraftList, DraftListItem, DraftListStatus } from "@/lib/gmail/draft-list";
import type { GmailOverview } from "@/lib/gmail/overview";
import { apiRequest } from "@/lib/client/api";
import type { MemberCounters } from "@/lib/gmail/sent-counter";

/** How often the counters re-check the server while the tab is visible (the whole page also refreshes every 30 s). */
export const COUNTER_POLL_MS = 15_000;

/**
 * Live Draft / Sent counts. Starts from the server-rendered values, asks /api/gmail/counters as soon as the page mounts, then every 15 s while visible and whenever the tab regains focus. A newer server render replaces the state.
 */
function useLiveCounters(initial: MemberCounters): MemberCounters {
  const [counts, setCounts] = useState(initial);
  // A newer server render (page refresh / the 30 s auto-refresh) replaces the live state: adjust state while rendering, the React-recommended way.
  const [seen, setSeen] = useState(initial);
  if (seen.drafted !== initial.drafted || seen.sent !== initial.sent) {
    setSeen({ drafted: initial.drafted, sent: initial.sent });
    setCounts({ drafted: initial.drafted, sent: initial.sent });
  }
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const r = await apiRequest<MemberCounters>("/api/gmail/counters");
      if (alive && r.ok) setCounts({ drafted: r.data.drafted, sent: r.data.sent });
    };
    const first = window.setTimeout(load, 0); // right after mount: also reconciles with Gmail
    const id = window.setInterval(load, COUNTER_POLL_MS);
    document.addEventListener("visibilitychange", load);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", load);
      window.removeEventListener("focus", load);
    };
  }, []);
  return counts;
}

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
    <div className="flex min-w-[8.5rem] items-center gap-3 rounded-xl border border-line bg-navy-900/70 px-4 py-2.5" data-testid={`gmail-count-${label.toLowerCase()}`}>
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
 * Gmail Drafts page: the title, the member's own Draft and Sent counts (Draft first, Sent to its right; live), who is connected, and the
 * member's own Network Finder drafts. The Sent COUNT is only e-mails JobSync's automated workflow sent (confirmed in the send ledger).
 * Each member connects, reconnects or disconnects their own Gmail from Profile → Gmail; Google sends them back here,
 * so the outcome of a connect is shown as a notice.
 */
export function GmailConnect({ members, drafts, justConnected, error }: { members: GmailOverview["members"]; drafts: DraftList; justConnected: boolean; error?: string }) {
  const [notice, setNotice] = useState<NoticeState | null>(
    justConnected ? { kind: "success", text: "Gmail connected. Network Finder can now save drafts in your Gmail (it never sends)." } : error ? { kind: "error", text: ERRORS[error] ?? "Gmail could not be connected." } : null,
  );
  const counts = useLiveCounters({ drafted: drafts.drafted, sent: drafts.sent });
  return (
    <div className="space-y-4">
      {/* Title left, the Draft and Sent counts (Draft first, Sent directly to its right) centred at every width, connected members right. */}
      <div className="grid items-center gap-x-6 gap-y-3 sm:grid-cols-[1fr_auto_1fr]">
        <h1 className="text-xl font-semibold">Gmail drafts</h1>
        <div className="flex flex-wrap items-center justify-center gap-3" aria-label="Draft and sent counts" role="group" data-testid="gmail-counts">
          <SummaryCard label="Draft" value={counts.drafted} icon={Mail} tone="text-amber-300" />
          <SummaryCard label="Sent" value={counts.sent} icon={Send} tone="text-emerald-300" />
        </div>
        <div className="sm:justify-self-end">
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
