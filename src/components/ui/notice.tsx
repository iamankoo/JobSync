import { CheckCircle2, XCircle, X } from "lucide-react";

export interface NoticeState {
  kind: "success" | "error";
  text: string;
}

/** Inline, dismissible feedback. Errors use role="alert", successes role="status". */
export function Notice({ notice, onDismiss }: { notice: NoticeState | null; onDismiss: () => void }) {
  if (!notice) return null;
  const ok = notice.kind === "success";
  return (
    <div
      role={ok ? "status" : "alert"}
      className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
        ok ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100" : "border-red-500/40 bg-red-500/10 text-red-100"
      }`}
    >
      {ok ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-300" aria-hidden /> : <XCircle size={18} className="mt-0.5 shrink-0 text-red-300" aria-hidden />}
      <p className="flex-1">{notice.text}</p>
      <button type="button" onClick={onDismiss} aria-label="Dismiss message" className="rounded p-0.5 opacity-80 hover:opacity-100">
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
