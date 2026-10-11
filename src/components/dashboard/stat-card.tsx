import type { LucideIcon } from "lucide-react";
import { Sparkline } from "@/components/charts/sparkline";

interface Props {
  label: string;
  value: number;
  caption: string;
  icon: LucideIcon;
  /** Tailwind classes for the card background/border. */
  tone: string;
  iconTone: string;
  /** Last 7 days, oldest first (omit for no sparkline). */
  spark?: number[];
  sparkColor?: string;
  sparkLabel?: string;
}

export function StatCard({ label, value, caption, icon: Icon, tone, iconTone, spark, sparkColor = "#60a5fa", sparkLabel }: Props) {
  return (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex items-center gap-3">
        <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl text-white ${iconTone}`}>
          <Icon size={24} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink/90">{label}</p>
          <p className="text-3xl font-bold leading-tight">{value}</p>
        </div>
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="min-w-0 text-xs text-muted">{caption}</p>
        {spark && <Sparkline values={spark} color={sparkColor} label={sparkLabel ?? `${label}: last 7 days`} />}
      </div>
    </div>
  );
}
