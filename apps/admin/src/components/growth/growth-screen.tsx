import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ADMIN_PREVIEW_PREFIX, ROUTES } from '@hushbox/shared';
import { useOps } from '@/hooks/use-ops';
import { canManageCampaigns } from './campaign-controls.js';
import { ClickOverlay } from './click-overlay.js';
import { dataEdgeNote, newestGrowthDay } from './data-edge.js';
import { GrowthFilters } from './growth-filters.js';
import { campaignColumns, CampaignsPanel } from './campaigns-panel.js';
import { CohortGrid, cohortColumns, cohorts } from './cohort-grid.js';
import { campaignNarrowing, ceilingReachedColumn, WHOLE_READ } from './csv.js';
import { eventTotals } from './events-panel.js';
import { ExportButton } from './export-button.js';
import { FunnelPanel } from './funnel-panel.js';
import { campaignScoped, ladderColumns, ladderCsvColumns } from './funnel-math.js';
import { GeoPanel } from './geo-panel.js';
import { geoColumns } from './geo-table.js';
import { GrowthPanel, PANEL_GRID, panelDataOr, readOutcome } from './growth-panel.js';
import { HeadlineTiles } from './headline-tiles.js';
import {
  eventsPanelScope,
  MarketingPanels,
  NamedEventsPanel,
  NO_MARKETING,
} from './marketing-panels.js';
import { ReachPanel } from './reach-panel.js';
import { GROWTH_SECTIONS, GrowthSection, GrowthSectionRail } from './section-rail.js';
import { SourcesPanel } from './sources-panel.js';
import {
  figuresOutsideSelection,
  headlineAbsentColumns,
  headlineColumns,
  headlineFigures,
  headlineFileWeeks,
} from './headline-figures.js';
import {
  CAMPAIGN_NARROWED,
  campaignNarrowedExcept,
  NO_CAMPAIGN_DIMENSION,
  SELECTED_WEEK,
} from './panel-scope.js';
import { bucketingOfGrain, summedCountLabel } from './summed-label.js';
import { geoTotals, productEntryMarginal, totalVisitorsMarginal } from './marketing-rows.js';
import {
  cohortWindow,
  dayOf,
  editedRange,
  initialRange,
  isoWeekStart,
  weekOptions,
  weekWindow,
  windowSpan,
} from './growth-window.js';
import {
  growthKeys,
  useGrowthCampaigns,
  useGrowthEvents,
  useGrowthFreshness,
  useGrowthFunnel,
  useGrowthMarketing,
  useGrowthReach,
  useGrowthSources,
} from './use-growth-reads.js';
import type { OverlayPage } from './click-overlay-boxes.js';
import type { GrowthSectionId } from './section-rail.js';
import type { CsvExtent } from './csv.js';
import type { DataEdgeStatus } from './data-edge.js';
import type { EventTotal } from './events-panel.js';
import type { UnscopedMarginals } from './headline-figures.js';
import type { WindowScope } from './panel-scope.js';
import type { GrowthWindow } from './use-growth-reads.js';
import type {
  GrowthCampaignWire,
  GrowthFreshnessWire,
  GrowthFunnelWeekWire,
  GrowthGrain,
  GrowthReachRowWire,
  GrowthSourceCountWire,
} from '@hushbox/shared';

/** Weeks the picker offers, and the span the ladder and sparklines are read over. */
const COHORT_WEEKS = 12;

/** The visitor series' default span, at day grain. */
const SERIES_DAYS = 90;

/** The span the ladder and the self-reported sources cover, whichever week is picked. */
const LADDER_SPAN: WindowScope = { kind: 'recent-weeks', weeks: COHORT_WEEKS };

/**
 * Where the click overlay starts: the prefix the admin origin serves its copy of
 * the site at, and the site's entry page. The path is the panel's own control's
 * initial value rather than the page it always frames; the panel offers every
 * marketing route and keeps which one is framed.
 */
const OVERLAY_PAGE: OverlayPage = {
  basePath: `/${ADMIN_PREVIEW_PREFIX}`,
  path: ROUTES.MARKETING,
};

/**
 * What a panel stands for while its read is in flight or after it degraded.
 * Typed by the rows they stand in for rather than inferred from the empty
 * literal, so a control reading one still knows what a row looks like.
 */
const NO_WEEKS: { readonly weeks: readonly GrowthFunnelWeekWire[] } = { weeks: [] };
const NO_FRESHNESS: GrowthFreshnessWire = {
  funnel: null,
  sources: null,
  marketing: null,
  events: null,
};
const NO_CAMPAIGNS: { readonly rows: readonly GrowthCampaignWire[] } = { rows: [] };
const NO_REACH: { readonly rows: readonly GrowthReachRowWire[] } = { rows: [] };
const NO_SOURCES: { readonly rows: readonly GrowthSourceCountWire[] } = { rows: [] };
const NO_TOTALS: readonly EventTotal[] = [];

/**
 * What the figures on the badges over the framed page were counted from,
 * against what the named-events read answered with.
 *
 * Said in both cases rather than only where pages are missing: the badges carry
 * no pager of their own, so silence would leave a reader unable to tell a
 * figure counted from the whole read from one counted from the page in hand,
 * and reading a partial figure as a whole one is the mistake this page must not
 * invite.
 */
function badgeCoverage(page: number, hasMore: boolean): string {
  if (page === 0 && !hasMore) {
    return 'The named-events read answered in one page, so these figures were counted from every row it returned.';
  }
  return `These figures were counted from page ${String(page + 1)} of the named-events read alone; whatever it returned on its other pages is in no badge here.`;
}

/**
 * What the visitor series says it covers, read off the window itself rather
 * than the days the controls show: a refused edit leaves those two apart, and
 * the sentence owes the window that was read.
 *
 * A trailing run of days is named as one only while it still reaches today;
 * a range that ended earlier is named by both of its days, because "the last N
 * days" is false of it.
 */
function rangeScope(window: GrowthWindow, today: string): WindowScope {
  const span = windowSpan(window);
  if (span.endDay === today) return { kind: 'recent-days', days: span.days };
  return { kind: 'day-range', startDay: dayOf(new Date(window.from)), endDay: span.endDay };
}

export function GrowthScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const ops = useOps();
  const [now] = React.useState(() => new Date());
  const weeks = React.useMemo(() => weekOptions(now, COHORT_WEEKS), [now]);
  const [selectedWeek, setSelectedWeek] = React.useState(() => isoWeekStart(now).toISOString());
  const [selectedCampaigns, setSelectedCampaigns] = React.useState<readonly string[]>([]);
  const [grain, setGrain] = React.useState<GrowthGrain>('day');
  const [eventsPage, setEventsPage] = React.useState(0);
  const [range, setRange] = React.useState(() => initialRange(now, SERIES_DAYS));
  // When this page last spent a round of reads, which the toolbar states the
  // age of: the mount spends one, and Refresh is the only thing that spends
  // another.
  const [readAt, setReadAt] = React.useState(() => now.getTime());

  const ladderWindow = React.useMemo(() => cohortWindow(now, COHORT_WEEKS), [now]);
  const selectedWindow = React.useMemo(() => weekWindow(new Date(selectedWeek)), [selectedWeek]);
  // An hour-grain series over ninety days would be a bucket per hour per family;
  // at that grain the window narrows to the selected week instead. The window and
  // what the panels built on it say they cover come out of the same branch, so a
  // panel cannot claim a span its read did not ask for.
  const series = React.useMemo(
    () =>
      grain === 'day'
        ? { window: range.window, scope: rangeScope(range.window, dayOf(now)) }
        : { window: selectedWindow, scope: SELECTED_WEEK },
    [grain, now, range, selectedWindow]
  );

  /**
   * The one campaign the events read can be narrowed to. That read takes a
   * single tag, so a selection of two or more reads every campaign, exactly as
   * an empty selection does. The panel is handed this same value and states the
   * scope from it, so what it says it covers cannot disagree with what it was
   * read with.
   */
  const soleCampaign = selectedCampaigns.length === 1 ? selectedCampaigns[0] : undefined;

  const eventsScope = eventsPanelScope(soleCampaign);

  const freshness = useGrowthFreshness();
  const funnel = useGrowthFunnel(ladderWindow);
  const marketing = useGrowthMarketing(series.window, grain);
  // The two campaign-free marginals the leading figures read, each over the week
  // selected and at the grain its figure is counted over — the visitor figure
  // daily, matching its per-campaign twin, and the entry figure hourly, the only
  // grain that family exists at. Read apart from the series above so the grain
  // toggle cannot change what a tile measures. At hour grain the series read asks
  // the same question as one of these and the cache answers both from one call.
  const weekVisitors = useGrowthMarketing(selectedWindow, 'day');
  const weekEntrants = useGrowthMarketing(selectedWindow, 'hour');
  const sources = useGrowthSources(ladderWindow);
  const campaigns = useGrowthCampaigns();
  const events = useGrowthEvents(selectedWindow, soleCampaign, eventsPage);
  const reach = useGrowthReach(selectedWindow);

  const allWeeks = panelDataOr(funnel, (payload) => payload.panels.funnel, NO_WEEKS).weeks;
  const scopedWeeks = campaignScoped(allWeeks, selectedCampaigns);
  const laddersForWeek = scopedWeeks.filter((week) => week.week === selectedWeek);

  const campaignRows = panelDataOr(
    campaigns,
    (payload) => payload.panels.campaigns,
    NO_CAMPAIGNS
  ).rows;
  const marketingData = panelDataOr(marketing, (payload) => payload.panels.marketing, NO_MARKETING);
  const marginals: UnscopedMarginals = {
    visitors: totalVisitorsMarginal(
      panelDataOr(weekVisitors, (payload) => payload.panels.marketing, NO_MARKETING).rows
    ),
    productEntryClicks: productEntryMarginal(
      panelDataOr(weekEntrants, (payload) => payload.panels.marketing, NO_MARKETING).rows
    ),
  };
  // The ladder-backed exports are filtered on this page rather than by the read,
  // so a campaign selection can leave their files holding fewer rows than the read
  // answered with, and nothing in them shows which were dropped.
  const ladderExtent: CsvExtent = {
    page: null,
    campaigns: campaignNarrowing(selectedCampaigns, []),
    absentColumns: null,
  };
  // A selection of several campaigns reaches the account figures while the
  // anonymous ones come from the campaign-free marginal, so the panel and its
  // file name what it misses rather than declaring the whole of themselves
  // narrowed.
  const unreachedFigures = figuresOutsideSelection(selectedCampaigns);
  const headline = headlineFigures(allWeeks, selectedWeek, selectedCampaigns, marginals);

  const eventsPanel = events.data?.panels.events;
  const sourceRows = panelDataOr(sources, (payload) => payload.panels.sources, NO_SOURCES).rows;

  // The status line keeps the freshness read's three outcomes apart, so a
  // refusal states its code where a sentence drawn from a drained read would
  // have said the data stops before the week selected.
  const edgeOutcome = readOutcome(freshness, (payload) => payload.panels.freshness);
  const edge: DataEdgeStatus =
    edgeOutcome.state === 'answered'
      ? {
          state: 'answered',
          note: dataEdgeNote(
            newestGrowthDay(
              panelDataOr(freshness, (payload) => payload.panels.freshness, NO_FRESHNESS)
            ),
            dayOf(new Date(selectedWeek))
          ),
        }
      : edgeOutcome;

  const badgeTotals = React.useMemo(() => {
    if (eventsPanel?.ok !== true) return NO_TOTALS;
    return eventTotals(eventsPanel.data.rows);
  }, [eventsPanel]);

  /**
   * Which panels answer each of the screen's four questions. A record rather
   * than four blocks of layout, so the compiler holds it to the sections the
   * rail links: a section with no panels, or panels under a section the rail
   * cannot reach, will not type.
   */
  const panels: Record<GrowthSectionId, React.ReactNode> = {
    conversion: (
      <>
        {/*
        The leading figures are drawn from three reads — the ladder and the two
        campaign-free marginals — so the panel watches all three: a refusal
        states its code and a read still in flight draws nothing. A marginal
        drained to no rows instead would have its tile state that the week holds
        no whole-site row, which is a claim about the product rather than about
        the read that failed.
      */}
        <GrowthPanel
          span="full"
          title="This week"
          reserves="medium"
          scope={{
            campaigns: campaignNarrowedExcept('one-at-a-time', unreachedFigures),
            window: SELECTED_WEEK,
          }}
          query={funnel}
          panelOf={(payload) => payload.panels.funnel}
          alsoReads={[
            readOutcome(weekVisitors, (payload) => payload.panels.marketing),
            readOutcome(weekEntrants, (payload) => payload.panels.marketing),
          ]}
          actions={
            // The rows are every week the ladder rows behind this file carry, together
            // with any week a stated figure holds a point in: the ladder half keeps a
            // file whose every figure is withheld from holding no rows at all, which
            // would read as a read that returned nothing, and the figure half keeps a
            // figure read for the week on screen from earning a column of empty
            // fields. The columns are the other half of that — a figure withheld earns
            // none, so the file names it and gives the tile's reason rather than
            // leaving the reader a headline that looks complete.
            <ExportButton
              name="growth-headline"
              extent={{
                ...ladderExtent,
                campaigns: campaignNarrowing(selectedCampaigns, unreachedFigures),
                absentColumns: {
                  selectedWeek,
                  columns: headlineAbsentColumns(headline),
                },
              }}
              rows={headlineFileWeeks(scopedWeeks, headline)}
              columns={headlineColumns(headline)}
            />
          }
          render={(data) => (
            <HeadlineTiles
              figures={headlineFigures(data.weeks, selectedWeek, selectedCampaigns, marginals)}
            />
          )}
        />

        <div className={PANEL_GRID}>
          <GrowthPanel
            span={7}
            title="Funnel"
            reserves="tall"
            scope={{ campaigns: CAMPAIGN_NARROWED, window: SELECTED_WEEK }}
            query={funnel}
            panelOf={(payload) => payload.panels.funnel}
            actions={
              <ExportButton
                name="growth-funnel"
                extent={ladderExtent}
                rows={scopedWeeks}
                columns={[
                  { header: 'Week', value: (row) => row.week },
                  { header: 'Campaign', value: (row) => row.campaign },
                  ...ladderColumns().flatMap((column) =>
                    ladderCsvColumns<GrowthFunnelWeekWire>(column, (row) => [row])
                  ),
                  { header: 'Revenue (nano USD)', value: (row) => row.revenueNanoUsd },
                ]}
              />
            }
            render={() =>
              laddersForWeek.length === 0 ? (
                <p className="text-muted-foreground text-sm">No ladder for this week.</p>
              ) : (
                <div className="flex flex-col gap-4">
                  {laddersForWeek.map((week) => (
                    <FunnelPanel key={week.campaign} week={week} />
                  ))}
                </div>
              )
            }
          />

          <GrowthPanel
            span={5}
            title="Cohorts"
            reserves="tall"
            scope={{ campaigns: CAMPAIGN_NARROWED, window: LADDER_SPAN }}
            query={funnel}
            panelOf={(payload) => payload.panels.funnel}
            actions={
              <ExportButton
                name="growth-cohorts"
                extent={ladderExtent}
                rows={cohorts(scopedWeeks)}
                columns={cohortColumns()}
              />
            }
            render={() => <CohortGrid weeks={scopedWeeks} />}
          />
        </div>
      </>
    ),

    traffic: (
      <>
        <div className={PANEL_GRID}>
          <MarketingPanels marketing={marketing} grain={grain} seriesScope={series.scope} />

          <GrowthPanel
            span={7}
            title="Landed on, then reached"
            reserves="tall"
            scope={{ campaigns: NO_CAMPAIGN_DIMENSION, window: SELECTED_WEEK }}
            query={reach}
            panelOf={(payload) => payload.panels.reach}
            actions={
              <ExportButton
                name="growth-reach"
                extent={WHOLE_READ}
                rows={panelDataOr(reach, (payload) => payload.panels.reach, NO_REACH).rows}
                columns={[
                  { header: 'Landing', value: (row) => row.landingPath },
                  { header: 'Reached', value: (row) => row.reachedPath },
                  {
                    header: summedCountLabel('Visitors', 'daily'),
                    value: (row) => row.visitorsDailySummed,
                  },
                  ceilingReachedColumn(),
                ]}
              />
            }
            render={(data) => <ReachPanel rows={data.rows} />}
          />
        </div>

        <GrowthPanel
          span="full"
          title="Where visitors are"
          reserves="tall"
          scope={{ campaigns: NO_CAMPAIGN_DIMENSION, window: series.scope }}
          query={marketing}
          panelOf={(payload) => payload.panels.marketing}
          actions={
            <ExportButton
              name="growth-geo"
              extent={WHOLE_READ}
              rows={geoTotals(marketingData.rows)}
              columns={geoColumns(bucketingOfGrain(marketingData.grain))}
            />
          }
          render={(data) => <GeoPanel rows={data.rows} bucketing={bucketingOfGrain(data.grain)} />}
        />
      </>
    ),

    behaviour: (
      <div className={PANEL_GRID}>
        <NamedEventsPanel events={events} campaign={soleCampaign} onPageChange={setEventsPage} />

        <GrowthPanel
          span={8}
          title="Where people clicked"
          reserves="tall"
          scope={eventsScope}
          query={events}
          panelOf={(payload) => payload.panels.events}
          render={(data) => (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground text-xs">
                {badgeCoverage(data.page, data.hasMore)}
              </p>
              <ClickOverlay page={OVERLAY_PAGE} totals={badgeTotals} />
            </div>
          )}
        />
      </div>
    ),

    attribution: (
      <div className={PANEL_GRID}>
        <GrowthPanel
          span={6}
          title="Where people said they heard of us"
          reserves="medium"
          scope={{
            campaigns: { kind: 'every-campaign', reason: 'not-narrowed' },
            window: LADDER_SPAN,
          }}
          query={sources}
          panelOf={(payload) => payload.panels.sources}
          actions={
            <ExportButton
              name="growth-sources"
              extent={WHOLE_READ}
              rows={sourceRows}
              columns={[
                { header: 'Created week', value: (row) => row.userCreatedWeek },
                { header: 'Campaign', value: (row) => row.campaign },
                { header: 'Channel', value: (row) => row.selfReportedChannel },
                { header: 'Asked at', value: (row) => row.selfReportedContext },
                { header: 'Primary source', value: (row) => row.primarySource },
                // The export keeps the read's own rows where {@link SourcesPanel} groups
                // them, so this column counts the accounts behind one of the read's rows
                // rather than a group's total.
                { header: 'Accounts', value: (row) => row.accounts },
              ]}
            />
          }
          render={(data) => <SourcesPanel rows={data.rows} />}
        />

        <GrowthPanel
          span={6}
          title="Campaigns"
          reserves="medium"
          scope={{
            campaigns: { kind: 'every-campaign', reason: 'is-the-list' },
            window: { kind: 'unwindowed' },
          }}
          query={campaigns}
          panelOf={(payload) => payload.panels.campaigns}
          actions={
            <ExportButton
              name="growth-campaigns"
              extent={WHOLE_READ}
              rows={campaignRows}
              columns={campaignColumns()}
            />
          }
          render={(data) => (
            <CampaignsPanel rows={data.rows} canManage={canManageCampaigns(ops.data?.ops)} />
          )}
        />
      </div>
    ),
  };

  return (
    <section data-slot="growth-screen" className="flex flex-col gap-4 p-4">
      {/*
        The toolbar and the rail stick as one group, so the controls and where
        the reader is stay in view together. Full bleed rather than inside the
        page's padding: both carry their own, and a stuck header inset from the
        edges would let the panels scroll through the gutters beside it.
      */}
      <div className="bg-background border-border z-20 -mx-4 -mt-4 border-b md:sticky md:top-0">
        <GrowthFilters
          weeks={weeks}
          selectedWeek={selectedWeek}
          onWeekChange={(week) => {
            setSelectedWeek(week);
            setEventsPage(0);
          }}
          grain={grain}
          onGrainChange={setGrain}
          range={range.shown}
          onRangeChange={(days) => {
            setRange((current) => editedRange(current, days));
          }}
          campaigns={campaignRows}
          selectedCampaigns={selectedCampaigns}
          onCampaignToggle={(tag, chosen) => {
            setSelectedCampaigns((selected) =>
              chosen ? [...selected, tag] : selected.filter((each) => each !== tag)
            );
            // The page a reader is on names rows of the selection they left, so it
            // is returned with the selection exactly as a change of week returns
            // it: the events read is narrowed by the selection, and page 3 of the
            // old scope is not page 3 of the new one.
            setEventsPage(0);
          }}
          refusal={range.refusal}
          edge={edge}
          readAt={readAt}
          onRefresh={() => {
            setReadAt(Date.now());
            void queryClient.invalidateQueries({ queryKey: growthKeys.all });
          }}
        />
        <GrowthSectionRail />
      </div>

      {GROWTH_SECTIONS.map((section) => (
        <GrowthSection key={section.id} section={section}>
          {panels[section.id]}
        </GrowthSection>
      ))}
    </section>
  );
}
