"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, CalendarDays, CheckCircle2, Clock, FileText, MailCheck, Send, Star, Trophy, Users, XCircle, type LucideIcon } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { MEMBERS, type MemberId } from "@/config/members";
import type { EmailsSentStats } from "@/lib/gmail/sent-stats";
import { BarChart } from "@/components/charts/bar-chart";
import { DonutChart } from "@/components/charts/donut-chart";
import { HBarList } from "@/components/charts/hbar-list";
import { PALETTE, STATUS_COLORS } from "@/components/charts/colors";
import { RingGauge } from "@/components/charts/ring-gauge";
import { TrendChart } from "@/components/charts/trend-chart";
import { buttonClass } from "@/components/ui/button";
import { ActivityPanel } from "./activity-panel";
import { DeadlinesPanel } from "./deadlines-panel";
import { CompanyMark } from "@/components/ui/company-mark";
import { EmptyState } from "@/components/ui/empty-state";
import { computeAnalytics } from "@/lib/analytics/analytics";
import type { AnalyticsRange, AnalyticsSource, Change, StatCardData } from "@/types/insights";

const RANGES: { value: string; range: AnalyticsRange; label: string; compare: string }[] = [
  { value: "7", range: 7, label: "Last 7 Days", compare: "previous 7 days" },
  { value: "30", range: 30, label: "Last 30 Days", compare: "previous 30 days" },
  { value: "90", range: 90, label: "Last 90 Days", compare: "previous 90 days" },
  { value: "all", range: "all", label: "All Time", compare: "" },
];

/** The donut splits applications by their STATUS value (mutually exclusive, sums to the total). */
const STATUS_LABELS: Record<string, string> = { Applied: "Awaiting response", Interview: "Interviewed", Offer: "Offer" };

const CARD_STYLE: Record<StatCardData["key"], { icon: LucideIcon; tone: string; iconTone: string }> = {
  total: { icon: FileText, tone: "border-blue-500/40 bg-gradient-to-br from-blue-600/25 to-navy-900", iconTone: "bg-blue-600" },
  applied: { icon: CheckCircle2, tone: "border-emerald-500/40 bg-gradient-to-br from-emerald-600/25 to-navy-900", iconTone: "bg-emerald-500" },
  inProgress: { icon: Clock, tone: "border-amber-500/40 bg-gradient-to-br from-amber-600/25 to-navy-900", iconTone: "bg-amber-500" },
  shortlisted: { icon: Star, tone: "border-lime-500/40 bg-gradient-to-br from-lime-600/25 to-navy-900", iconTone: "bg-lime-600" },
  interviewed: { icon: Users, tone: "border-violet-500/40 bg-gradient-to-br from-violet-600/25 to-navy-900", iconTone: "bg-violet-600" },
  offers: { icon: Trophy, tone: "border-cyan-500/40 bg-gradient-to-br from-cyan-600/25 to-navy-900", iconTone: "bg-cyan-600" },
  rejected: { icon: XCircle, tone: "border-red-500/40 bg-gradient-to-br from-red-600/25 to-navy-900", iconTone: "bg-red-600" },
};

/** One compact line: "↑ 28% vs previous 30 days". Hidden when there is nothing to compare. */
function ChangeText({ change, compare, value }: { change: Change; compare: string; value: number }) {
  if (change.direction === "none" || (change.direction === "flat" && value === 0)) return null;
  const rest = <span className="font-normal text-muted"> vs {compare}</span>;
  if (change.direction === "up")
    return <p className="mt-2 flex flex-wrap items-center gap-x-1 text-xs font-semibold text-emerald-400"><ArrowUp size={13} aria-hidden />{change.pct}%{rest}</p>;
  if (change.direction === "down")
    return <p className="mt-2 flex flex-wrap items-center gap-x-1 text-xs font-semibold text-red-400"><ArrowDown size={13} aria-hidden />{change.pct}%{rest}</p>;
  if (change.direction === "new") return <p className="mt-2 text-xs font-semibold text-emerald-400">New{rest}</p>;
  return <p className="mt-2 text-xs font-semibold text-muted">No change{rest}</p>;
}

function Panel({ title, note, children, className = "" }: { title: string; note?: string; children: React.ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={`rounded-xl border border-line bg-navy-900/70 p-5 ${className}`}>
      <h2 className="mb-1 text-lg font-semibold">{title}</h2>
      {note && <p className="mb-3 text-xs text-muted">{note}</p>}
      {!note && <div className="mb-3" />}
      {children}
    </section>
  );
}

/**
 * Personal analytics. `source` holds ONLY the signed-in member's own applications and activity
 * (plus open deadlines of shared jobs); every number is computed from it by `computeAnalytics`.
 */
/**
 * Emails actually sent from Gmail (JobSync drafts the member reviewed and sent themselves). Counted from the
 * sent-draft tracker's ledger, so drafts and generated emails never count. All time, independent of the range.
 */
function EmailsSentCard({ stats, me }: { stats: EmailsSentStats | null; me?: MemberId }) {
  const mine = stats && me ? stats.byMember[me] : null;
  return (
    <section aria-labelledby="emails-sent" className="rounded-xl border border-sky-500/40 bg-gradient-to-br from-sky-600/25 to-navy-900 p-4" data-testid="emails-sent-card">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-sky-600 text-white">
            <MailCheck size={22} aria-hidden />
          </span>
          <div>
            <p className="text-2xl font-bold leading-none" data-testid="emails-sent-total">{stats ? stats.total : "–"}</p>
            <h2 id="emails-sent" className="mt-1 text-xs text-ink/90">Emails Sent</h2>
          </div>
        </div>
        {stats ? (
          <ul aria-label="Emails sent per member" className="flex flex-wrap items-center gap-3">
            {MEMBERS.map((m) => (
              <li key={m.id} className="flex items-center gap-2 rounded-lg bg-navy-950/50 px-2.5 py-1.5 text-sm">
                <Avatar member={m} size={22} ring={m.id === me} />
                <span>{m.id === me ? "You" : m.name}</span>
                <span className="font-semibold tabular-nums" data-testid={`emails-sent-${m.id}`}>{stats.byMember[m.id]}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Sent-email tracking is not set up yet.</p>
        )}
      </div>
      <p className="mt-3 text-xs text-muted">
        {mine !== null ? `You have sent ${mine}. ` : ""}Counts emails you sent from Gmail drafts JobSync created, once Gmail shows them as sent. Unsent or deleted drafts are not counted. All time.
      </p>
    </section>
  );
}

export function AnalyticsView({ source, emailsSent = null, me, timeZone = "UTC" }: { source: AnalyticsSource; emailsSent?: EmailsSentStats | null; me?: MemberId; timeZone?: string }) {
  const [rangeKey, setRangeKey] = useState("30");
  const meta = RANGES.find((r) => r.value === rangeKey)!;
  const result = useMemo(() => computeAnalytics(source, meta.range), [source, meta.range]);
  const totalInRange = result.cards[1].value; // Applied (in the chosen range)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="mt-1 text-lg text-muted">Insights into your job search progress</p>
        </div>
        <label className="relative block">
          <span className="sr-only">Time range</span>
          <CalendarDays size={18} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-electric-soft" />
          <select
            value={rangeKey}
            onChange={(e) => setRangeKey(e.target.value)}
            className="h-12 min-w-[12rem] appearance-none rounded-lg border border-line bg-navy-900 pl-10 pr-9 text-sm font-medium text-ink outline-none hover:border-electric-soft focus-visible:border-electric-soft"
          >
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </label>
      </div>

      <section aria-label="Application totals" className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4 2xl:grid-cols-7">
        {result.cards.map((c) => {
          const { icon: Icon, tone, iconTone } = CARD_STYLE[c.key];
          return (
            <div key={c.key} className={`rounded-xl border p-4 ${tone}`}>
              <div className="flex items-center gap-3">
                <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white ${iconTone}`}>
                  <Icon size={22} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-2xl font-bold leading-none">{c.value}</p>
                  <p className="mt-1 truncate text-xs text-ink/90">{c.label}</p>
                </div>
              </div>
              <ChangeText change={c.change} compare={meta.compare} value={c.value} />
            </div>
          );
        })}
      </section>

      <EmailsSentCard stats={emailsSent} me={me} />

      {!result.hasApplications ? (
        <EmptyState
          icon={Send}
          title="No applications yet"
          message="Mark a job as applied and your status breakdown, trends and response rate will appear here. Only your own applications are used."
        >
          <Link href="/all-jobs" className={buttonClass("primary")}>Browse All Jobs</Link>
        </EmptyState>
      ) : (
        <>
          {totalInRange === 0 && (
            <p role="status" className="rounded-lg border border-line bg-navy-900/60 px-4 py-3 text-sm text-muted">
              You haven&apos;t applied to anything in this period. Pick a longer range to see your history.
            </p>
          )}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.7fr)]">
            <Panel title="Application Status Distribution">
              <DonutChart
                ariaLabel="Application status distribution"
                centerValue={totalInRange}
                centerLabel="Applications"
                slices={result.statusDistribution.map((d) => ({ label: STATUS_LABELS[d.label] ?? d.label, value: d.value, color: STATUS_COLORS[d.label as keyof typeof STATUS_COLORS] }))}
              />
            </Panel>
            <Panel title="Applications Over Time" note="Cumulative, grouped by the day you applied. Each application counts under its current status.">
              <TrendChart
                ariaLabel="Applications over time"
                labels={result.trend.labels}
                series={result.trend.series.map((s) => ({ ...s, color: STATUS_COLORS[s.key as keyof typeof STATUS_COLORS] }))}
              />
            </Panel>
            <Panel title="Response Rate">
              <RingGauge
                percent={result.response.percent}
                label="Response Rate"
                caption={
                  result.response.total === 0
                    ? "No applications in this period"
                    : `${result.response.responded} out of ${result.response.total} applications received a response`
                }
              />
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <Panel title="Job Type Distribution">
              <BarChart ariaLabel="Job type distribution" bars={result.jobTypes.map((d, i) => ({ label: d.label, value: d.value, color: PALETTE[i % PALETTE.length] }))} />
            </Panel>
            <Panel title="Top Companies (Applied)">
              {result.topCompanies.length === 0 ? (
                <p className="text-sm text-muted">No applications in this period.</p>
              ) : (
                <HBarList ariaLabel="Top companies" items={result.topCompanies.map((d) => ({ label: d.label, value: d.value, leading: <CompanyMark name={d.label} size={28} /> }))} />
              )}
            </Panel>
            <Panel title="Location Distribution">
              <DonutChart
                ariaLabel="Location distribution"
                centerValue={totalInRange}
                centerLabel="Applications"
                size={150}
                slices={result.locations.map((d, i) => ({ label: d.label, value: d.value, color: PALETTE[i % PALETTE.length] }))}
              />
            </Panel>
          </div>
        </>
      )}

      <div className={`grid grid-cols-1 gap-5 ${result.hasApplications ? "xl:grid-cols-3" : ""}`}>
        {result.hasApplications && (
          <Panel title="Experience Level Distribution">
            {result.experience.length === 0 ? (
              <p className="text-sm text-muted">No applications in this period.</p>
            ) : (
              <HBarList ariaLabel="Experience level distribution" items={result.experience.map((d) => ({ label: d.label, value: d.value }))} />
            )}
          </Panel>
        )}
        <Panel
          title="Application Timeline"
          note="Your own activity this quarter, from saved records. Hover, focus or tap a day for details. It moves to the next quarter automatically."
          className={result.hasApplications ? "xl:col-span-2" : ""}
        >
          <ActivityPanel timeline={result.activity} />
        </Panel>
      </div>

      <Panel title="Deadlines Overview" note="Open jobs you haven't applied to yet, nearest deadline first. 'Due today' means the deadline is today's date.">
        <DeadlinesPanel deadlines={result.deadlines} timeZone={timeZone} />
      </Panel>
    </div>
  );
}
