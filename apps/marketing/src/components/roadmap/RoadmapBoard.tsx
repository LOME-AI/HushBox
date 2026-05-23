import * as React from 'react';
import { useRoadmapQuery } from './use-roadmap-query';
import { useFilterState, type FilterStatus } from './use-filter-state';
import { computeBoard } from './compute-board';
import { FilterChips } from './FilterChips';
import { StatusSection } from './StatusSection';
import { EmptyState } from './EmptyState';

const STATUS_ORDER: readonly FilterStatus[] = ['in_progress', 'planned', 'shipped'];

/**
 * Top-level React island for the public roadmap page. Owns the API query
 * and the filter state; everything below is presentational. The shell
 * renders a loading state and an error state — once data arrives, the
 * board is a stack of {@link StatusSection}s with {@link FilterChips}
 * pinned above and {@link EmptyState} substituted when filters yield no
 * visible projects.
 */
export function RoadmapBoard(): React.JSX.Element {
  const { data, error, isLoading } = useRoadmapQuery();
  const { statuses, types, toggleStatus, toggleType, reset } = useFilterState();

  const board = React.useMemo(() => {
    if (data === null) return null;
    return computeBoard(data.nodes);
  }, [data]);

  if (isLoading) {
    return <BoardSkeleton />;
  }

  if (error !== null || board === null) {
    return <BoardError />;
  }

  const visibleSections = STATUS_ORDER.filter((status) => statuses.has(status));
  const visibleCount = visibleSections.reduce(
    (sum, status) => sum + board.byStatus[status].length,
    0
  );

  return (
    <div className="flex flex-col gap-8" data-roadmap-ready>
      <FilterChips
        statuses={statuses}
        types={types}
        statusCounts={board.statusCounts}
        typeCounts={board.typeCounts}
        onToggleStatus={toggleStatus}
        onToggleType={toggleType}
      />
      {visibleCount === 0 ? (
        <EmptyState onReset={reset} />
      ) : (
        visibleSections.map((status) => (
          <StatusSection
            key={status}
            status={status}
            projects={board.byStatus[status]}
            activeTypes={types}
          />
        ))
      )}
    </div>
  );
}

function BoardSkeleton(): React.JSX.Element {
  return (
    <div
      data-testid="roadmap-loading"
      role="status"
      aria-label="Loading roadmap"
      className="border-border bg-background-subtle/40 flex h-64 animate-pulse items-center justify-center rounded-lg border"
    />
  );
}

function BoardError(): React.JSX.Element {
  return (
    <div
      role="alert"
      className="border-border bg-background rounded-md border p-6 text-center"
    >
      <p className="text-foreground-muted text-sm">
        The roadmap is temporarily unavailable. Please try again shortly.
      </p>
    </div>
  );
}
