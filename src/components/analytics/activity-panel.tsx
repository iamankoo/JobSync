import { Heatmap } from "@/components/charts/heatmap";
import type { ActivityTimeline } from "@/lib/analytics/activity";

/**
 * The member's own activity for the current quarter, from the persisted Activity records.
 * Hover, focus or tap a day for its date, Job Applied and work streak.
 */
export function ActivityPanel({ timeline }: { timeline: ActivityTimeline }) {
  const s = timeline.summary;
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-ink/90">{timeline.period.label}</p>
      <Heatmap weeks={timeline.weeks} monthLabels={timeline.monthLabels} totalActions={s.totalActions} periodLabel={timeline.period.label} />
      {s.totalActions === 0 && s.visits === 0 && (
        <p className="mt-3 text-sm text-muted">No activity recorded yet. Adding a job, marking one applied or updating an application will show up here.</p>
      )}
    </div>
  );
}
