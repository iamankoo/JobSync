import { Check, Clock, Trophy, Users, X, type LucideIcon } from "lucide-react";
import type { ApplicationStatus } from "@/types/domain";

const STATUS_STYLE: Record<ApplicationStatus, { cls: string; Icon: LucideIcon }> = {
  "Not Applied": { cls: "border-slate-500/40 bg-slate-500/15 text-slate-200", Icon: X },
  Applied: { cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300", Icon: Check },
  "In Progress": { cls: "border-amber-500/40 bg-amber-500/15 text-amber-300", Icon: Clock },
  Interview: { cls: "border-violet-500/40 bg-violet-500/20 text-violet-200", Icon: Users },
  Offer: { cls: "border-cyan-500/40 bg-cyan-500/15 text-cyan-200", Icon: Trophy },
  Rejected: { cls: "border-red-500/40 bg-red-500/15 text-red-300", Icon: X },
};

export function StatusBadge({ status }: { status: ApplicationStatus }) {
  const { cls, Icon } = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-semibold ${cls}`}>
      <Icon size={14} aria-hidden />
      {status}
    </span>
  );
}

const TYPE_STYLE: Record<string, string> = {
  "Full-time": "border-blue-500/40 bg-blue-500/15 text-blue-200",
  Internship: "border-violet-500/40 bg-violet-500/20 text-violet-200",
  "Part-time": "border-teal-500/40 bg-teal-500/15 text-teal-200",
  Contract: "border-orange-500/40 bg-orange-500/15 text-orange-200",
};

export function TypeBadge({ type }: { type: string }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-semibold ${TYPE_STYLE[type] ?? "border-line bg-navy-800 text-ink"}`}>
      {type}
    </span>
  );
}
