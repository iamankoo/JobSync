import { AlertTriangle, type LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  message,
  children,
}: {
  icon: LucideIcon;
  title: string;
  message: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line bg-navy-900/60 px-6 py-14 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-navy-700 text-electric-soft">
        <Icon size={28} aria-hidden />
      </span>
      <h2 className="mt-4 text-xl font-semibold">{title}</h2>
      <p className="mt-1 max-w-md text-muted">{message}</p>
      {children && <div className="mt-6 flex flex-wrap justify-center gap-3">{children}</div>}
    </div>
  );
}

/** Shown when the data layer fails. Never replaced with sample data. */
export function ErrorState({ title, message }: { title: string; message: string }) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-xl border border-red-500/40 bg-red-500/10 px-6 py-14 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-red-500/20 text-red-300">
        <AlertTriangle size={28} aria-hidden />
      </span>
      <h2 className="mt-4 text-xl font-semibold">{title}</h2>
      <p className="mt-1 max-w-md text-red-100/90">{message}</p>
      <p className="mt-4 text-sm text-muted">Reload the page to try again. Nothing was changed.</p>
    </div>
  );
}
