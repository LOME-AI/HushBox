/**
 * Skeleton rendered while the roadmap data loads. Stays close to the final
 * constellation footprint so the layout doesn't shift when real data
 * arrives. Uses pure CSS pulse — no JS animation library, no motion that
 * conflicts with reduced-motion preferences.
 */
export function ConstellationSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label="Loading roadmap"
      data-roadmap-skeleton
      className="grid grid-cols-1 gap-6 md:grid-cols-3"
    >
      {[0, 1, 2].map((index) => (
        <div key={index} className="space-y-3">
          <div className="bg-muted h-6 w-32 animate-pulse rounded-full" />
          <div className="bg-muted h-3 w-48 animate-pulse rounded-full" />
          <div className="bg-muted h-3 w-40 animate-pulse rounded-full" />
          <div className="bg-muted h-3 w-44 animate-pulse rounded-full" />
        </div>
      ))}
    </div>
  );
}
