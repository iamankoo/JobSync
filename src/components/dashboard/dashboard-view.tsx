import Link from "next/link";
import { cellClass, HEAD_ROW_CLASS, ROW_CLASS, TABLE_CLASS, TBODY_CLASS, THEAD_CLASS, TH_CLASS } from "@/components/ui/responsive-table";

import { ArrowRight, Briefcase, CalendarDays, Clock, FileText, List, Plus, Send, Star, Target, Trophy, Users, Zap } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { buttonClass } from "@/components/ui/button";
import { CompanyMark } from "@/components/ui/company-mark";
import { EmptyState } from "@/components/ui/empty-state";
import { getMember, type Member } from "@/config/members";
import { formatDisplayDate } from "@/lib/jobs/query";
import type { DashboardData } from "@/types/insights";
import { StatCard } from "./stat-card";
import { TeamContribution } from "./team-contribution";

interface Props {
  member: Member;
  data: DashboardData;
  timeZone: string;
}

function dayLabel(days: number): { text: string; cls: string; dot: string } {
  if (days === 0) return { text: "Today", cls: "bg-red-500/20 text-red-300", dot: "bg-red-400" };
  if (days <= 3) return { text: `${days} day${days === 1 ? "" : "s"}`, cls: "bg-red-500/20 text-red-300", dot: "bg-red-400" };
  if (days <= 7) return { text: `${days} days`, cls: "bg-amber-500/20 text-amber-300", dot: "bg-amber-400" };
  return { text: `${days} days`, cls: "bg-blue-500/20 text-blue-200", dot: "bg-blue-400" };
}

function MiniStat({ icon: Icon, value, label, tone }: { icon: typeof Send; value: number; label: string; tone: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-navy-900 px-4 py-3">
      <Icon size={26} className={tone} aria-hidden />
      <div>
        <p className="text-xl font-bold leading-none">{value}</p>
        <p className="mt-1 text-sm text-muted">{label}</p>
      </div>
    </div>
  );
}

/**
 * Personalised dashboard. Personal numbers are the signed-in member's own; the team contribution
 * chart is the shared summary. Everything shown is derived from real Google Sheets records.
 */
export function DashboardView({ member, data, timeZone }: Props) {
  const todayLabel = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", year: "numeric", timeZone }).format(
    new Date(`${data.today}T12:00:00Z`),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">
            Welcome back, {member.name} <span aria-hidden>👋</span>
          </h1>
          <p className="mt-1 text-lg text-muted">Let&apos;s find your next opportunity.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-navy-900/70 px-4 py-2.5">
            <CalendarDays size={26} className="text-electric-soft" aria-hidden />
            <div>
              <p className="text-sm font-semibold">{todayLabel}</p>
              <p className="text-xs text-muted">Keep going! Consistency wins.</p>
            </div>
          </div>
          <Link href="/add-job" className={buttonClass("primary", "px-5 py-3")}>
            <Plus size={18} aria-hidden /> Add New Job
          </Link>
        </div>
      </div>

      <section aria-label="Overview" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total Jobs" value={data.totalJobs} caption="Across team" icon={FileText}
          tone="border-blue-500/40 bg-gradient-to-br from-blue-600/25 to-navy-900" iconTone="bg-blue-600"
          spark={data.sparklines.jobs} sparkColor="#60a5fa" sparkLabel="Jobs added per day, last 7 days"
        />
        <StatCard
          label="My Applications" value={data.myApplied} caption="Applied by you" icon={Send}
          tone="border-emerald-500/40 bg-gradient-to-br from-emerald-600/25 to-navy-900" iconTone="bg-emerald-500"
          spark={data.sparklines.applications} sparkColor="#34d399" sparkLabel="Your applications per day, last 7 days"
        />
        <StatCard
          label="Pending" value={data.myPending} caption="Awaiting response" icon={Clock}
          tone="border-amber-500/40 bg-gradient-to-br from-amber-600/25 to-navy-900" iconTone="bg-amber-500"
          spark={data.sparklines.pending} sparkColor="#fbbf24" sparkLabel="Your pending applications per day, last 7 days"
        />
        <StatCard
          label="Team Members" value={data.activeMemberCount} caption={data.activeMemberNames.join(", ") || "No active members"} icon={Users}
          tone="border-violet-500/40 bg-gradient-to-br from-violet-600/25 to-navy-900" iconTone="bg-violet-600"
        />
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section aria-labelledby="daily-target" className="flex flex-col rounded-xl border border-line bg-navy-900/70 p-5">
          <div className="flex items-start gap-4">
            <Target size={44} className="shrink-0 text-electric-soft" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 id="daily-target" className="text-lg font-semibold">My Daily Target</h2>
              <p className="text-sm text-muted">Add new job opportunities today</p>
            </div>
            <p className="text-3xl font-bold" aria-label={`${data.daily.addedToday} of ${data.daily.target} jobs added today`}>
              {data.daily.addedToday} <span className="text-muted">/ {data.daily.target}</span>
            </p>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <div
              role="progressbar"
              aria-label="Daily target progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={data.daily.percent}
              className="h-3 flex-1 overflow-hidden rounded-full bg-navy-700"
            >
              <div className="h-full rounded-full bg-accent-strong transition-[width] duration-700" style={{ width: `${data.daily.percent}%` }} />
            </div>
            <span className="w-10 text-right text-sm tabular-nums text-muted">{data.daily.percent}%</span>
          </div>
          <div className="mt-auto grid grid-cols-2 gap-3 pt-5 sm:grid-cols-3">
            <MiniStat icon={Plus} value={data.daily.addedToday} label="Added today" tone="text-blue-400" />
            <MiniStat icon={Send} value={data.daily.applied} label="Applied (total)" tone="text-emerald-400" />
            <MiniStat icon={Clock} value={data.daily.pending} label="Pending" tone="text-amber-400" />
            <MiniStat icon={Star} value={data.daily.shortlisted} label="Shortlisted" tone="text-lime-400" />
            <MiniStat icon={Users} value={data.daily.interviewed} label="Interviewed" tone="text-violet-400" />
            <MiniStat icon={Trophy} value={data.daily.offers} label="Offers" tone="text-cyan-400" />
          </div>
        </section>

        <TeamContribution data={data.contribution} />
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section aria-labelledby="recent-jobs" className="rounded-xl border border-line bg-navy-900/70">
          <div className="flex items-center justify-between gap-3 p-5 pb-3">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-blue-600/30 text-blue-300"><FileText size={20} aria-hidden /></span>
              <div>
                <h2 id="recent-jobs" className="text-lg font-semibold">Recent Jobs</h2>
                <p className="text-sm text-muted">Latest opportunities added by the team</p>
              </div>
            </div>
            <Link href="/all-jobs" className={buttonClass("secondary", "px-3 py-1.5")}>
              View All <ArrowRight size={14} aria-hidden />
            </Link>
          </div>
          {data.recentJobs.length === 0 ? (
            <div className="p-5 pt-2">
              <EmptyState icon={Briefcase} title="No jobs yet" message="Jobs added by you or your teammates will show up here.">
                <Link href="/add-job" className={buttonClass("primary")}>
                  <Plus size={16} aria-hidden /> Add New Job
                </Link>
              </EmptyState>
            </div>
          ) : (
            <div className="relative overflow-x-auto">
              <table role="table" className={TABLE_CLASS}>
                <caption className="sr-only">Most recently added jobs</caption>
                <thead role="rowgroup" className={THEAD_CLASS + " border-t"}>
                  <tr role="row" className={HEAD_ROW_CLASS}>
                    {["#", "Job Title", "Company", "Location", "Added By", "Applied", "Date"].map((h) => (
                      <th role="columnheader" key={h} scope="col" className={TH_CLASS}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody role="rowgroup" className={TBODY_CLASS}>
                  {data.recentJobs.map(({ job, applied }, i) => {
                    const adder = getMember(job.addedBy);
                    return (
                      <tr role="row" key={job.jobId} className={ROW_CLASS}>
                        <td role="cell" data-label="#" className={cellClass("text-muted", "index")}>{i + 1}</td>
                        <td role="cell" data-label="Job Title" className={cellClass("font-medium", "title")}>
                          <Link href={`/all-jobs?q=${encodeURIComponent(job.jobRole)}`} className="hover:text-electric-soft hover:underline">{job.jobRole}</Link>
                        </td>
                        <td role="cell" data-label="Company" className={cellClass("")}><span className="flex items-center gap-2"><CompanyMark name={job.company} size={26} />{job.company}</span></td>
                        <td role="cell" data-label="Location" className={cellClass("")}>{job.location}</td>
                        <td role="cell" data-label="Added By" className={cellClass("")}>
                          <span className="flex items-center gap-2">
                            {adder && <Avatar member={adder} size={24} />}
                            {adder?.name ?? "Unknown"}
                          </span>
                        </td>
                        <td role="cell" data-label="Applied" className={cellClass("")}>
                          <span className={`inline-block rounded-md px-3 py-1 text-xs font-semibold ${applied ? "bg-emerald-600/30 text-emerald-300" : "bg-red-600/30 text-red-300"}`}>
                            {applied ? "Yes" : "No"}
                          </span>
                        </td>
                        <td role="cell" data-label="Date" className={cellClass("whitespace-nowrap")}>{formatDisplayDate(job.addedAt, timeZone).slice(0, 6)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="space-y-5">
          <section aria-labelledby="quick-actions" className="rounded-xl border border-line bg-navy-900/70 p-5">
            <h2 id="quick-actions" className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <Zap size={20} className="text-blue-400" aria-hidden /> Quick Actions
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <Link href="/add-job" className="flex items-center gap-3 rounded-lg bg-blue-600 px-4 py-3 text-white transition hover:brightness-110">
                <Plus size={26} aria-hidden />
                <span><span className="block font-semibold">Add New Job</span><span className="block text-xs text-white">Share a new opportunity</span></span>
              </Link>
              <Link href="/all-jobs" className="flex items-center gap-3 rounded-lg bg-emerald-700 px-4 py-3 text-white transition hover:brightness-110">
                <List size={26} aria-hidden />
                <span><span className="block font-semibold">Browse All Jobs</span><span className="block text-xs text-white">Explore team&apos;s jobs</span></span>
              </Link>
              <Link href="/my-applications" className="flex items-center gap-3 rounded-lg bg-amber-700 px-4 py-3 text-white transition hover:brightness-110 sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                <Send size={26} aria-hidden />
                <span><span className="block font-semibold">My Applications</span><span className="block text-xs text-white">Track your applications</span></span>
              </Link>
            </div>
          </section>

          <section aria-labelledby="deadlines" className="rounded-xl border border-line bg-navy-900/70 p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="deadlines" className="flex items-center gap-2 text-lg font-semibold">
                <CalendarDays size={20} className="text-electric-soft" aria-hidden /> Upcoming Deadlines
              </h2>
              <Link href="/all-jobs" className={buttonClass("secondary", "px-3 py-1.5")}>
                View All <ArrowRight size={14} aria-hidden />
              </Link>
            </div>
            {data.upcomingDeadlines.length === 0 ? (
              <p className="text-sm text-muted">No upcoming deadlines for jobs you haven&apos;t applied to.</p>
            ) : (
              <ul className="space-y-3">
                {data.upcomingDeadlines.map(({ job, daysLeft }) => {
                  const tone = dayLabel(daysLeft);
                  return (
                    <li key={job.jobId} className="flex items-center gap-3 text-sm">
                      <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone.dot}`} />
                      <Link href={`/all-jobs?q=${encodeURIComponent(job.jobRole)}`} className="min-w-0 flex-1 truncate hover:text-electric-soft hover:underline">
                        {job.company} {job.jobRole}
                      </Link>
                      <span className="whitespace-nowrap text-muted">{formatDisplayDate(job.deadline, timeZone).slice(0, 6)}</span>
                      <span className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold ${tone.cls}`}>{tone.text}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
