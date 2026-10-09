import { daysUntil, deadlineTone, formatDisplayDate, type DeadlineTone } from "@/lib/jobs/query";

const TONE_CLASS: Record<DeadlineTone, string> = {
  overdue: "text-red-400",
  urgent: "text-red-400",
  soon: "text-amber-300",
  normal: "text-ink",
  none: "text-muted",
};

/** Deadline date coloured by urgency. Overdue/urgent are also announced in text, not by colour alone. */
export function DeadlineText({ deadline, today, timeZone }: { deadline?: string; today: string; timeZone: string }) {
  const tone = deadlineTone(deadline, today);
  let hint = "";
  if (deadline) {
    const days = daysUntil(deadline, today);
    if (days < 0) hint = "Deadline passed";
    else if (days === 0) hint = "Due today";
    else if (days <= 7) hint = `${days} day${days === 1 ? "" : "s"} left`;
  }
  return (
    <span className={`whitespace-nowrap ${TONE_CLASS[tone]}`} title={hint || undefined}>
      {formatDisplayDate(deadline, timeZone)}
      {hint && <span className="sr-only"> ({hint})</span>}
    </span>
  );
}
