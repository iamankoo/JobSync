import { Briefcase } from "lucide-react";

/** Round JobSync badge (the app logo's briefcase) shown in place of a member photo for Connections JobSync added automatically. */
export function JobSyncMark({ size }: { size: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-full border border-electric text-electric" style={{ width: size, height: size }} aria-hidden>
      <Briefcase size={Math.round(size * 0.55)} />
    </span>
  );
}
