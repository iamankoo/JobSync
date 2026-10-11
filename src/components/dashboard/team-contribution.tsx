"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { BarChart } from "@/components/charts/bar-chart";
import { MEMBERS } from "@/config/members";
import type { ContributionPeriod, ContributionRow } from "@/types/insights";

const PERIODS: { value: ContributionPeriod; label: string }[] = [
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "all", label: "All Time" },
];

/** Jobs added per member. A shared team summary: it contains no application data. */
export function TeamContribution({ data }: { data: Record<ContributionPeriod, ContributionRow[]> }) {
  const [period, setPeriod] = useState<ContributionPeriod>("week");
  const id = useId();
  const rows = data[period];
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const periodLabel = PERIODS.find((p) => p.value === period)!.label;

  return (
    <section aria-labelledby={id} className="rounded-xl border border-line bg-navy-900/70 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="text-lg font-semibold">
          Team Contribution <span className="text-electric-soft">(Jobs Added)</span>
        </h2>
        <label className="relative block w-full min-w-[9rem] sm:w-40">
          <span className="sr-only">Period</span>
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as ContributionPeriod)}
            className="h-10 w-full appearance-none rounded-lg border border-line bg-navy-900 pl-3 pr-9 text-sm text-ink outline-none hover:border-electric-soft focus-visible:border-electric-soft"
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <ChevronDown size={16} aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
        </label>
      </div>
      <BarChart
        ariaLabel={`Jobs added, ${periodLabel}`}
        bars={rows.map((r) => ({ label: r.name, value: r.count, color: MEMBERS.find((m) => m.id === r.memberId)!.accent }))}
      />
      {total === 0 && <p className="mt-1 text-center text-sm text-muted">No jobs added {periodLabel === "All Time" ? "yet" : "in this period yet"}.</p>}
      <div className="mt-3 border-t border-line pt-3">
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Meaningful actions · team-wide, {periodLabel.toLowerCase()}</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Meaningful actions per member">
          {rows.map((r) => (
            <li key={r.memberId} className="flex items-center gap-1.5">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: MEMBERS.find((m) => m.id === r.memberId)!.accent }} />
              {r.name} <span className="font-semibold tabular-nums">{r.actions}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[11px] text-muted">Counts only: adds, applications, updates and follow-ups. Visits are not included.</p>
      </div>
    </section>
  );
}
