import * as React from 'react';
import { Heading } from '@hushbox/ui/type';
import { publicUsageStatsSchema } from '@hushbox/shared';
import { usePublicQuery } from '../../lib/use-public-query';
import { PillGroup } from '../ui/pill-group';
import {
  availableModalities,
  availableWindows,
  dotPlotPositions,
  rankModels,
  selectView,
  tickSpan,
  trendSeries,
  xAxisTicks,
} from './compute-stats';
import { placeholderStats } from './placeholder-data';
import { TrendChart } from './TrendChart';
import { RankedList } from './RankedList';
import { CostCard } from './CostCard';
import { CostDotPlot } from './CostDotPlot';
import type { Modality, UsageStatsWindow, UsageStatsWindowKey } from '@hushbox/shared';

function modalityLabel(modality: Modality): string {
  return modality.charAt(0).toUpperCase() + modality.slice(1);
}

function windowLabel(window: UsageStatsWindow): string {
  return window.days === null ? 'All time' : `${String(window.days)} days`;
}

/**
 * Top-level React island for the public stats page. Owns the API query and
 * the modality/window selection; everything below is presentational. The
 * loading state renders the same tree against a placeholder dataset wrapped
 * in `data-skeleton` + `inert` (the roadmap island's ghost-UI convention).
 * Selection is resolved through `selectView`, so a selection invalidated by
 * the loaded payload falls back instead of crashing.
 *
 * E2E state signals (names registered in `TEST_SIGNALS`): once the fetch has
 * resolved, either branch carries `data-stats-settled="true"`; only the
 * loaded-with-data wrapper also carries `data-stats-ready`. The loading
 * skeleton carries neither, so tests can distinguish not-yet-loaded,
 * loaded-unavailable, and loaded-with-data.
 */
export function StatsBoard(): React.JSX.Element {
  const { data, error, isLoading } = usePublicQuery(
    '/public/stats',
    publicUsageStatsSchema,
    'stats'
  );
  const [selectedModality, setSelectedModality] = React.useState<Modality | null>(null);
  const [selectedWindow, setSelectedWindow] = React.useState<UsageStatsWindowKey | null>(null);
  const headId = React.useId();

  const effectiveData = isLoading ? placeholderStats : data;
  const view =
    effectiveData === null ? null : selectView(effectiveData, selectedModality, selectedWindow);

  if (error !== null || effectiveData === null || view === null) {
    return <StatsUnavailable />;
  }

  const modalities = availableModalities(effectiveData);
  const windows = availableWindows(effectiveData, view.modality);
  const ranked = rankModels(view.stats);
  const bands = trendSeries(view.stats.trend, ranked, view.stats.others.sharePercent);
  const ticks = xAxisTicks(view.window, view.stats.trend);

  const body = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PillGroup
          label="Modality"
          options={modalities.map((modality) => ({
            value: modality,
            label: modalityLabel(modality),
          }))}
          value={view.modality}
          onChange={setSelectedModality}
        />
        <PillGroup
          label="Window"
          options={windows.map((window) => ({ value: window.key, label: windowLabel(window) }))}
          value={view.window.key}
          onChange={setSelectedWindow}
        />
      </div>

      <section aria-labelledby={`${headId}-share`} className="flex flex-col gap-4">
        <Heading level={2} variant="site-subhead" tone="ink" id={`${headId}-share`}>
          Model share
        </Heading>
        <TrendChart
          bands={bands}
          ticks={ticks}
          ariaLabel={`Model share for ${modalityLabel(view.modality)}, ${windowLabel(view.window).toLowerCase()}, as a stacked area chart ${tickSpan(ticks)}. The ranking below carries the same data.`}
        />
        <RankedList models={ranked} others={view.stats.others} showDelta={view.window.hasDelta} />
      </section>

      <section aria-labelledby={`${headId}-cost`} className="flex flex-col gap-4">
        <Heading level={2} variant="site-subhead" tone="ink" id={`${headId}-cost`}>
          Cost per message
        </Heading>
        <CostCard cost={view.stats.cost} />
      </section>

      <section aria-labelledby={`${headId}-models`} className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <Heading level={2} variant="site-subhead" tone="ink" id={`${headId}-models`}>
            Cost by model
          </Heading>
          <span className="text-muted-foreground text-sm">average per message</span>
        </div>
        <CostDotPlot entries={dotPlotPositions(ranked)} />
      </section>
    </>
  );

  if (isLoading) {
    return (
      <div
        className="flex flex-col gap-10"
        data-skeleton
        inert
        role="status"
        aria-label="Loading stats"
        aria-busy={true}
      >
        {body}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10" data-stats-settled="true" data-stats-ready>
      {body}
    </div>
  );
}

function StatsUnavailable(): React.JSX.Element {
  return (
    <div
      role="alert"
      data-stats-settled="true"
      className="border-border bg-background rounded-md border p-6 text-center"
    >
      <p className="text-muted-foreground text-sm">Stats are unavailable right now.</p>
    </div>
  );
}
