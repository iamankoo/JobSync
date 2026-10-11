import Link from "next/link";
import { DonutChart } from "@/components/charts/donut-chart";
import { formatDisplayDate } from "@/lib/jobs/query";
import type { AnalyticsResult } from "@/types/insights";

const BUCKET_COLORS = ["#ef4444", "#f59e0b", "#3b82f6", "#22c55e"];

function badgeClass(state: "past" | "today" | "upcoming", approaching: boolean): string {
  if (state === "today") return "bg-red-500/25 text-red-200";
  if (state === "past") return "bg-slate-500/25 text-slate-200";
  return approaching ? "bg-amber-500/25 text-amber-200" : "bg-blue-500/20 text-blue-100";
}

/**
 * Open jobs the member has NOT applied to, with real deadlines. "Due today" means the deadline
 * date equals today's date in the app timezone. Jobs without a (valid) deadline are never given
 * one; they are only counted.
 */
export function DeadlinesPanel({ deadlines, timeZone }: { deadlines: AnalyticsResult["deadlines"]; timeZone: string }) {
  const upcoming = deadlines.items.filter((i) => i.info.state !== "past");
  const past = deadlines.items.filter((i) => i.info.state === "past");

  if (deadlines.items.length === 0) {
    return (
      <div>
        <p className="text-sm text-muted">No upcoming deadlines for jobs you haven&apos;t applied to.</p>
        {deadlines.noDeadline > 0 && <NoDeadlineNote count={deadlines.noDeadline} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {deadlines.total > 0 && (
        <DonutChart
          ariaLabel="Upcoming deadlines"
          centerValue={deadlines.total}
          centerLabel="Upcoming Deadlines"
          size={150}
          slices={deadlines.buckets.map((d, i) => ({ label: d.label, value: d.value, color: BUCKET_COLORS[i] }))}
        />
      )}

      {upcoming.length > 0 && (
        <section aria-label="Upcoming deadlines list">
          <h3 className="mb-2 text-sm font-semibold">Upcoming (nearest first)</h3>
          <ul className="space-y-2">
            {upcoming.map((i) => (
              <DeadlineRow key={i.jobId} item={i} timeZone={timeZone} />
            ))}
          </ul>
        </section>
      )}

      {past.length > 0 && (
        <section aria-label="Past deadlines">
          <h3 className="mb-2 text-sm font-semibold text-muted">Past deadlines (not applied)</h3>
          <ul className="space-y-2">
            {past.map((i) => (
              <DeadlineRow key={i.jobId} item={i} timeZone={timeZone} />
            ))}
          </ul>
        </section>
      )}

      {deadlines.noDeadline > 0 && <NoDeadlineNote count={deadlines.noDeadline} />}
    </div>
  );
}

function NoDeadlineNote({ count }: { count: number }) {
  return (
    <p className="text-xs text-muted">
      {count} open job{count === 1 ? " has" : "s have"} no deadline listed.
    </p>
  );
}

function DeadlineRow({ item, timeZone }: { item: AnalyticsResult["deadlines"]["items"][number]; timeZone: string }) {
  const { info } = item;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-line bg-navy-950/50 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <Link href={`/all-jobs?q=${encodeURIComponent(item.jobRole)}`} className="block truncate font-medium hover:text-electric-soft hover:underline" title={`${item.jobRole} at ${item.company}: view the job`}>
          {item.jobRole}
        </Link>
        <p className="truncate text-xs text-muted">{item.company}</p>
      </div>
      <span className="whitespace-nowrap text-xs text-muted">{formatDisplayDate(item.deadline, timeZone)}</span>
      <span className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold ${badgeClass(info.state, info.approaching)}`}>{info.remaining}</span>
    </li>
  );
}
