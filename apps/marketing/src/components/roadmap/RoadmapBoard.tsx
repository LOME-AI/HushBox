import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { roadmapResponseSchema } from '@hushbox/shared';
import { usePublicQuery } from '../../lib/use-public-query';
import { useTypeFilter } from './use-type-filter';
import { computeBoard } from './compute-board';
import { TypeFilter } from './TypeFilter';
import { RoadmapColumn } from './RoadmapColumn';
import { placeholderRoadmap } from './placeholder-data';
import type { FilterType, RoadmapStatus, TypeFilterValue } from './types';

const COLUMN_ORDER: readonly RoadmapStatus[] = ['in_progress', 'planned', 'shipped'];

const ACTIVE_TYPES: Readonly<Record<TypeFilterValue, ReadonlySet<FilterType>>> = {
  all: new Set<FilterType>(['feature', 'bug']),
  feature: new Set<FilterType>(['feature']),
  bug: new Set<FilterType>(['bug']),
};

/**
 * Top-level React island for the public roadmap page. Owns the API query and
 * the type filter; everything below is presentational. During loading the same
 * component tree renders against a placeholder dataset wrapped in
 * `data-skeleton` + `inert`; a global CSS rule masks the text into shimmer bars
 * (see `apps/marketing/src/styles/global.css`). Rendering the real tree as the skeleton means
 * a future layout change to
 * `apps/marketing/src/components/roadmap/ProjectCard.tsx` or
 * {@link TypeFilter} cannot drift away from what the skeleton displays.
 */
export function RoadmapBoard(): React.JSX.Element {
  const { data, error, isLoading } = usePublicQuery(
    '/public/roadmap',
    roadmapResponseSchema,
    'roadmap'
  );
  const { type, setType } = useTypeFilter();

  const effectiveData = isLoading ? placeholderRoadmap : data;
  const board = React.useMemo(
    () => (effectiveData === null ? null : computeBoard(effectiveData.nodes)),
    [effectiveData]
  );

  if (error !== null || board === null) {
    return <BoardError />;
  }

  const body = (
    <>
      <TypeFilter type={type} counts={board.typeCounts} onChange={setType} />
      {/* From 768 to 832 the gap eases in, so the narrowest columns still hold a
          subtask's last word beside its tag; from 832 it is the full 1.25rem. */}
      <div className="grid gap-8 md:grid-cols-3 md:gap-[clamp(0.75rem,calc(0.75rem_+_(100vw_-_768px)_*_0.1328),1.25rem)]">
        {COLUMN_ORDER.map((status) => (
          <RoadmapColumn
            key={status}
            status={status}
            projects={board.byStatus[status]}
            activeTypes={ACTIVE_TYPES[type]}
          />
        ))}
      </div>
    </>
  );

  if (isLoading) {
    return (
      <div
        className="flex flex-col gap-6"
        data-testid={TEST_IDS.roadmapLoading}
        data-skeleton
        inert
        role="status"
        aria-label="Loading roadmap"
        aria-busy={true}
      >
        {body}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-roadmap-ready>
      {body}
    </div>
  );
}

function BoardError(): React.JSX.Element {
  return (
    <div role="alert" className="border-border bg-background rounded-md border p-6 text-center">
      <p className="text-muted-foreground text-sm">
        The roadmap is temporarily unavailable. Please try again shortly.
      </p>
    </div>
  );
}
