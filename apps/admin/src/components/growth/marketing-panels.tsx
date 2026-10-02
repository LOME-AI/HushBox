import * as React from 'react';
import { EventsPanel } from './events-panel.js';
import { campaignNarrowing, ceilingReachedColumn, WHOLE_READ } from './csv.js';
import { ExportButton } from './export-button.js';
import { GrowthPanel, panelDataOr } from './growth-panel.js';
import { pageColumnHeaders, PagesPanel } from './pages-panel.js';
import { RankedBars } from './ranked-bars.js';
import { visitorsColumns, VisitorsPanel } from './visitors-panel.js';
import { pageTotals, referrerTotals, summedVisitorsLabel, totalSeries } from './marketing-rows.js';
import { CAMPAIGN_NARROWED, NO_CAMPAIGN_DIMENSION, SELECTED_WEEK } from './panel-scope.js';
import { bucketingOfGrain, perBucketCountLabel } from './summed-label.js';
import type { PanelScope, WindowScope } from './panel-scope.js';
import type { GrowthEventsRead, GrowthGrain, GrowthMarketingRead } from '@hushbox/shared';
import type { UseQueryResult } from '@tanstack/react-query';

/** The payload a loaded panel carries, picked out of its outcome union. */
type LoadedData<Panel> = Panel extends { ok: true; data: infer Data } ? Data : never;

/** What a referrer row names, on screen, in the panel's own table and in its file. */
const REFERRER_HEADER = 'Host';

/**
 * What a panel reads as before its read answers, or when the panel degraded.
 * Exported because the screen above draws the map from the same read and needs
 * the same stand-in; two literals could drift into two different grains.
 */
export const NO_MARKETING: LoadedData<GrowthMarketingRead['panels']['marketing']> = {
  grain: 'day',
  rows: [],
};
const NO_EVENTS: LoadedData<GrowthEventsRead['panels']['events']> = {
  page: 0,
  pageSize: 0,
  hasMore: false,
  rows: [],
};

/**
 * What the events read was scoped by, from the campaign it was read with.
 *
 * The events read takes one campaign tag, so a selection of two or more asks for
 * every campaign — the same rows an empty selection returns. Widening it would
 * cost one operation call per campaign against the reader's hourly budget.
 *
 * Two panels on one screen draw on this read and each states its own coverage,
 * so the derivation is called by both rather than spelled twice: two spellings
 * would let one panel claim a narrowing the other denies, for one read. Which
 * module holds it is reversible — {@link PanelScope}'s own module is as
 * plausible a home; the single definition is not.
 */
export function eventsPanelScope(campaign: string | undefined): PanelScope {
  return {
    campaigns:
      campaign === undefined
        ? { kind: 'every-campaign', reason: 'one-at-a-time' }
        : CAMPAIGN_NARROWED,
    window: SELECTED_WEEK,
  };
}

/**
 * The three panels built from the marketing marginals: what the site's visitors
 * did, as the read over the selected span answered.
 *
 * Grouped into one component because they share a read and a grain, and because
 * keeping them here is what lets the screen above stay a layout rather than a
 * pile of per-panel outcome checks. They are returned loose rather than in a box
 * of their own: the screen lays its section's panels out in one grid, and a
 * wrapper here would make these three a column inside a column of it.
 */
export function MarketingPanels({
  marketing,
  grain,
  seriesScope,
}: Readonly<{
  readonly marketing: UseQueryResult<GrowthMarketingRead>;
  readonly grain: GrowthGrain;
  /** The span the marketing read asked for, which each of its panels states. */
  readonly seriesScope: WindowScope;
}>): React.JSX.Element {
  const marketingRows = panelDataOr(
    marketing,
    (payload) => payload.panels.marketing,
    NO_MARKETING
  ).rows;
  const bucketing = bucketingOfGrain(grain);
  const pageHeaders = pageColumnHeaders(bucketing);
  const marketingScope: PanelScope = { campaigns: NO_CAMPAIGN_DIMENSION, window: seriesScope };

  return (
    <>
      <GrowthPanel
        span={8}
        title="Visitors"
        reserves="medium"
        scope={marketingScope}
        query={marketing}
        panelOf={(payload) => payload.panels.marketing}
        actions={
          <ExportButton
            name="growth-visitors"
            extent={WHOLE_READ}
            rows={totalSeries(marketingRows)}
            columns={visitorsColumns(grain)}
          />
        }
        render={(data) => <VisitorsPanel points={totalSeries(data.rows)} grain={data.grain} />}
      />

      <GrowthPanel
        span={4}
        title="Referrers"
        reserves="medium"
        scope={marketingScope}
        query={marketing}
        panelOf={(payload) => payload.panels.marketing}
        actions={
          <ExportButton
            name="growth-referrers"
            extent={WHOLE_READ}
            rows={referrerTotals(marketingRows)}
            columns={[
              { header: REFERRER_HEADER, value: (row) => row.key },
              { header: summedVisitorsLabel(grain), value: (row) => row.visitors },
              ceilingReachedColumn(),
            ]}
          />
        }
        render={(data) => (
          <RankedBars
            totals={referrerTotals(data.rows)}
            countLabel={summedVisitorsLabel(grain)}
            keyLabel={REFERRER_HEADER}
          />
        )}
      />

      <GrowthPanel
        span={5}
        title="Top pages"
        reserves="medium"
        scope={marketingScope}
        query={marketing}
        panelOf={(payload) => payload.panels.marketing}
        actions={
          <ExportButton
            name="growth-pages"
            extent={WHOLE_READ}
            rows={pageTotals(marketingRows)}
            columns={[
              { header: pageHeaders.path, value: (row) => row.key },
              { header: pageHeaders.visitors, value: (row) => row.visitors },
              { header: pageHeaders.landings, value: (row) => row.landings },
              ceilingReachedColumn(),
            ]}
          />
        }
        render={(data) => <PagesPanel totals={pageTotals(data.rows)} bucketing={bucketing} />}
      />
    </>
  );
}

/**
 * The named events panel: what visitors pressed, one page of the events read at
 * a time.
 *
 * Apart from the marketing panels above because it answers a different question
 * and draws on a different read, and beside them because both are about the
 * site rather than the product.
 */
export function NamedEventsPanel({
  events,
  campaign,
  onPageChange,
}: Readonly<{
  readonly events: UseQueryResult<GrowthEventsRead>;
  /** The one campaign the events read was narrowed to; absent means every campaign. */
  readonly campaign?: string | undefined;
  readonly onPageChange: (page: number) => void;
}>): React.JSX.Element {
  const eventsData = panelDataOr(events, (payload) => payload.panels.events, NO_EVENTS);
  return (
    <GrowthPanel
      span={4}
      title="Named events"
      reserves="medium"
      scope={eventsPanelScope(campaign)}
      query={events}
      panelOf={(payload) => payload.panels.events}
      actions={
        <ExportButton
          name="growth-events"
          extent={{
            page: { index: eventsData.page, hasMore: eventsData.hasMore },
            campaigns: campaignNarrowing(campaign === undefined ? [] : [campaign], []),
            absentColumns: null,
          }}
          rows={eventsData.rows}
          columns={[
            { header: 'Hour', value: (row) => row.hour },
            { header: 'Campaign', value: (row) => row.campaign },
            { header: 'Event', value: (row) => row.eventName },
            { header: 'Page', value: (row) => row.path },
            // The export keeps the read's own per-hour rows where {@link EventsPanel}
            // adds them up, so this column names a per-bucket figure and the table's a sum.
            { header: perBucketCountLabel('People', 'hourly'), value: (row) => row.visitors },
            ceilingReachedColumn(),
          ]}
        />
      }
      render={(data) => (
        <EventsPanel
          rows={data.rows}
          page={data.page}
          hasMore={data.hasMore}
          onPageChange={onPageChange}
        />
      )}
    />
  );
}
