import * as React from 'react';
import { MotionProvider } from '@hushbox/ui/accessibility';
import { useRoadmapQuery } from './use-roadmap-query';
import { ConstellationSkeleton } from './ConstellationSkeleton';
import { useMediaQuery } from './use-media-query';
import { Constellation } from './Constellation';
import { Filters } from './Filters';
import { useFilterState } from './use-filter-state';
import { computeVisible } from './compute-visible';

/**
 * Top-level React island for the public roadmap page. Wraps everything in
 * `MotionProvider` so Framer Motion respects both the OS reduced-motion
 * media query AND the in-app accessibility widget's "Stop animations"
 * toggle (the marketing app's a11y widget is a separate component but
 * shares the store).
 *
 * Architectural note: this island is the only React tree on the roadmap
 * page. Astro renders the shell statically, and we mount with
 * `client:visible` so the SVG + animation code only loads when the user
 * scrolls to the section.
 */
export function RoadmapIsland(): React.JSX.Element {
  const isWide = useMediaQuery('(min-width: 1024px)');
  const { data, error, isLoading } = useRoadmapQuery();
  const filterState = useFilterState();
  const visibleIds = React.useMemo(
    () =>
      data === null
        ? new Set<string>()
        : computeVisible(data, filterState.statuses, filterState.types),
    [data, filterState.statuses, filterState.types]
  );

  return (
    <MotionProvider>
      <Filters state={filterState} />
      {isLoading && <ConstellationSkeleton />}
      {error !== null && <RoadmapError />}
      {data !== null && (
        <div data-roadmap-ready data-layout={isWide ? 'wide' : 'narrow'}>
          <Constellation data={data} layout={isWide ? 'wide' : 'narrow'} visibleIds={visibleIds} />
        </div>
      )}
    </MotionProvider>
  );
}

function RoadmapError(): React.JSX.Element {
  return (
    <div role="alert" className="border-border bg-background rounded-md border p-6 text-center">
      <p className="text-foreground-muted text-sm">
        The roadmap is temporarily unavailable. Please try again shortly.
      </p>
    </div>
  );
}
