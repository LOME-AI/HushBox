import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartTooltipContent, RechartsChart } from '@hushbox/ui';
import { ceilingReachedColumn } from './csv.js';
import { formatVisitorCount } from './funnel-math.js';
import { bucketingOfGrain, perBucketCountLabel } from './summed-label.js';
import type { CsvColumn } from './csv.js';
import type { MarketingPoint } from './marketing-rows.js';
import type { GrowthGrain } from '@hushbox/shared';
import type { ChartConfig } from '@hushbox/ui';

/** The colour the series is drawn in, named through a chart token. */
const SERIES_COLOR = 'var(--chart-2)';

/**
 * How much of the series colour the area under the line carries.
 *
 * The line is the mark and the area is what gives it a shape to read; a fill at
 * full strength reverses that and makes ninety days of area the loudest thing
 * on the panel.
 */
const AREA_WASH = 0.18;

/**
 * The crosshair the tooltip draws at the hovered bucket, and the gridlines
 * behind the series, both from the hairline token.
 *
 * A bar chart could be read against the axis because each bucket had a bar to
 * find; a line cannot, so the crosshair is what ties a reading to its bucket.
 * The colour is a token rather than recharts' own default grey, which is a
 * literal that neither theme nor any contrast tier moves.
 */
const HAIRLINE = 'var(--border)';

/**
 * How deep the chart's own title sits in the document outline.
 *
 * One below the level the growth panels give their titles in
 * `apps/admin/src/components/growth/growth-panel.tsx`, so the chart reads as
 * inside its panel rather than beside it. Two headings at one level made the
 * panel and the chart peers, which is the flatness this names away.
 */
const CHART_HEADING_LEVEL = 4;

/** What this panel's bucket column is called, on screen and in the exported file. */
const BUCKET_HEADER = 'Bucket';

/**
 * This panel as a file: the bucket as the read spells it, that bucket's own
 * distinct count, and whether the count hit its set ceiling. The figure is
 * named for one bucket rather than as a sum, because nothing here adds buckets.
 */
export function visitorsColumns(grain: GrowthGrain): readonly CsvColumn<MarketingPoint>[] {
  return [
    { header: BUCKET_HEADER, value: (point) => point.bucket },
    {
      header: perBucketCountLabel('Visitors', bucketingOfGrain(grain)),
      value: (point) => point.visitors,
    },
    ceilingReachedColumn<MarketingPoint>(),
  ];
}

/**
 * A bucket's figure as the tooltip states it, marked as a floor exactly where
 * the data table below marks the same bucket. The plotted value stays a bare
 * number, so the series' own key is unaffected.
 *
 * The reading is looked up from the points by the bucket the datum names, not
 * carried on the datum: recharts copies a datum's fields onto the element it
 * draws that point with, so a field put there for the tooltip can land in the
 * document as an attribute — `overflow` is a real one, which is how a boolean
 * flag became one. A bucket the points do not carry prints plainly, because an
 * absent reading is not a reading that no ceiling was reached.
 */
function tooltipFigure(
  points: readonly MarketingPoint[],
  grain: GrowthGrain
): (value: number | string, datum?: Record<string, unknown>) => string {
  return (value, datum) => {
    const named = datum?.['label'];
    const point = points.find((each) => bucketLabel(each.bucket, grain) === named);
    return formatVisitorCount(Number(value), point?.overflow ?? null);
  };
}

/** rem rather than px: the text-size control scales the root font, which a pixel tick escapes. */
const AXIS_PROPS = { tick: { fontSize: '0.75rem' }, tickLine: false, axisLine: false } as const;

/**
 * How much clear room the bucket axis keeps between two day labels.
 *
 * The library measures each label and drops the ones that would sit closer than
 * this, so the figure is clearance rather than a label width. Its own default
 * of 5 is not enough for a date at the enlarged text sizes: at the widest tier
 * two days were drawn over each other, which destroys both of them. Measured at
 * 375 wide across every text-size tier.
 */
const AXIS_TICK_GAP = 24;

/** The trend in one word, for the caption — the insight, not the numbers. */
function directionOf(points: readonly MarketingPoint[]): string {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || first === last) return 'held steady';
  if (last.visitors > first.visitors) return 'rose';
  if (last.visitors < first.visitors) return 'fell';
  return 'held steady';
}

/**
 * A bucket label: the day, or the hour within it.
 *
 * Read off the wire string rather than through a parse, which is safe because
 * of one coupling: the read writes every bucket as
 * `row.bucket.toISOString()` in
 * `apps/api/src/slices/admin/domain/operations/growth.ts`, so the value is
 * always UTC with a fixed-width prefix, and the day is that prefix exactly.
 * A wire spelling that ever carried an offset would need this to parse.
 *
 * It is deliberately not the shared `dayOf` in
 * `apps/admin/src/components/growth/growth-window.ts`, which the toolbar, the
 * cohort rows, the trend table and the tile comparison all take the selected
 * week's day from. Three reasons, and the first is the one that decides it:
 * those four state one fact — which day the picked week opens on — so two
 * spellings of it disagreed on screen, while this states a different fact from
 * a different source, the day a returned series bucket is stamped with, and no
 * surface states that one twice. Second, `dayOf` takes a `Date`, so sharing it
 * needs a parse, and a malformed bucket would then throw out of a render where
 * a prefix degrades. Third, the hour branch has no shared counterpart at all,
 * so a collapse of the day branch alone would leave this function holding its
 * own second spelling regardless.
 */
function bucketLabel(bucket: string, grain: GrowthGrain): string {
  return grain === 'day' ? bucket.slice(0, 10) : bucket.slice(0, 16).replace('T', ' ');
}

/**
 * Visitors over the window, at whichever grain is selected.
 *
 * Every point is one bucket's own distinct-visitor cardinality: `growth_visitors`
 * is unique on grain and bucket, and `totalSeries` maps those rows to points one
 * for one. Nothing on this panel adds buckets together, so its figure is named
 * for the bucketing alone rather than as a summed count.
 */
export function VisitorsPanel({
  points,
  grain,
}: Readonly<{
  readonly points: readonly MarketingPoint[];
  readonly grain: GrowthGrain;
}>): React.JSX.Element {
  const label = perBucketCountLabel('Visitors', bucketingOfGrain(grain));
  // The tooltip names the series from this, so the figure carries one name
  // wherever this panel states it.
  const config: ChartConfig = { visitors: { label, color: SERIES_COLOR } };
  const data = points.map((point) => ({
    label: bucketLabel(point.bucket, grain),
    visitors: point.visitors,
  }));

  const dataTable = (
    <table>
      <caption>{label}</caption>
      <thead>
        <tr>
          <th scope="col">{BUCKET_HEADER}</th>
          <th scope="col">{label}</th>
        </tr>
      </thead>
      <tbody>
        {points.map((point) => (
          <tr key={point.bucket}>
            <th scope="row" className="pr-2">
              {bucketLabel(point.bucket, grain)}
            </th>
            <td className="pl-2">{formatVisitorCount(point.visitors, point.overflow)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <RechartsChart
      title={label}
      caption={`Visitors ${directionOf(points)} across the range. Each bucket is its own set of distinct visitors, so adding the buckets up counts a returning visitor once per bucket rather than once.`}
      config={config}
      dataTable={dataTable}
      ariaLabel={`${label} across ${String(points.length)} buckets.`}
      headingLevel={CHART_HEADING_LEVEL}
      isEmpty={points.length === 0}
      emptyMessage="Nothing was counted in this range"
      // The chart frame styles itself as a card, and this one is drawn inside a
      // panel that is already one; `docs/DESIGN.md` §5 rules cards are never
      // nested. The frame merges what it is handed over its own classes, so
      // each of these takes a group of them off rather than adding anything.
      className="rounded-none border-0 bg-transparent p-0"
    >
      {({ isAnimationActive, plotHeight }) => (
        // The frame's reserved height is what the plot starts from. Without a
        // starting size the plot's first render measures nothing, draws at a
        // negative width and height, and says so on the console every mount.
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 0, height: plotHeight }}
        >
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={HAIRLINE} vertical={false} />
            <XAxis
              dataKey="label"
              minTickGap={AXIS_TICK_GAP}
              // The caption speaks of the whole range, so the range's own ends
              // are the two labels that may not be dropped.
              interval="preserveStartEnd"
              {...AXIS_PROPS}
            />
            <YAxis {...AXIS_PROPS} />
            <Tooltip
              cursor={{ stroke: HAIRLINE }}
              content={<ChartTooltipContent valueFormatter={tooltipFigure(points, grain)} />}
            />
            <Area
              dataKey="visitors"
              type="monotone"
              stroke={SERIES_COLOR}
              fill={SERIES_COLOR}
              fillOpacity={AREA_WASH}
              // Ninety of them would be the panel's loudest mark and would say
              // nothing the line does not; the hovered bucket gets one instead.
              dot={false}
              isAnimationActive={isAnimationActive}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </RechartsChart>
  );
}
