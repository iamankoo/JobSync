/** Placeholder block shown while a page's data loads. Purely visual: no data, no numbers. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-xl bg-navy-800/80 ${className}`} />;
}

/** Page-level loading state with an accessible busy announcement. */
export function PageSkeleton({ title, cards = 4 }: { title: string; cards?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={`Loading ${title}`} className="space-y-5">
      <span className="sr-only">Loading {title}…</span>
      <div className="space-y-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-5 w-80 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: cards }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}
