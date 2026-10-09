import { ArrowLeft, ArrowRight } from "lucide-react";
import { pageWindow } from "@/lib/jobs/query";

interface Props {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  summary: string;
}

export function Pagination({ page, pageCount, onChange, summary }: Props) {
  const nav =
    "grid h-9 min-w-9 place-items-center rounded-md border border-line bg-navy-900 px-2 text-sm text-ink transition hover:border-electric-soft disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex flex-col items-start justify-between gap-3 border-t border-line px-4 py-4 sm:flex-row sm:items-center">
      <p className="text-sm text-muted" aria-live="polite">
        {summary}
      </p>
      {pageCount > 1 && (
        <nav aria-label="Pagination" className="flex items-center gap-1.5">
          <button type="button" className={nav} aria-label="Previous page" disabled={page <= 1} onClick={() => onChange(page - 1)}>
            <ArrowLeft size={16} aria-hidden />
          </button>
          {pageWindow(page, pageCount).map((p, i) =>
            p === null ? (
              <span key={`gap-${i}`} aria-hidden className="px-1 text-muted">
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                aria-label={`Page ${p}`}
                aria-current={p === page ? "page" : undefined}
                onClick={() => onChange(p)}
                className={
                  p === page
                    ? "grid h-9 min-w-9 place-items-center rounded-md bg-accent-strong px-2 text-sm font-semibold text-on-accent"
                    : nav
                }
              >
                {p}
              </button>
            ),
          )}
          <button type="button" className={nav} aria-label="Next page" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>
            <ArrowRight size={16} aria-hidden />
          </button>
        </nav>
      )}
    </div>
  );
}
