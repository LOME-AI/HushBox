import * as React from 'react';

import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { cn } from '../../lib/utilities';
import { ScrollRegion } from '../composites/scroll-region';
import { ChartContainer } from './chart';
import type { ChartConfig } from './chart';

/**
 * How tall the frame draws its plot, in pixels.
 *
 * A number rather than a utility class because the plot is handed it: a
 * responsive plot that starts with no measurement of its box renders at a
 * negative size and says so on the console, and the height is the one dimension
 * this frame fixes and can therefore hand over.
 */
const PLOT_HEIGHT = 220;

/**
 * The element a chart's title is drawn as, per level.
 *
 * Same mechanism as the panel frame's own heading level in
 * `packages/ui/src/components/composites/panel-frame.tsx`, so a screen that
 * sets both sets them one way rather than two. Two levels because those are the
 * depths this frame's callers sit at: a chart directly under a section heading,
 * and one inside a panel whose title already carries a heading. A caller
 * nesting deeper adds its level here, which widens the union below with it.
 */
const HEADING_TAG = { 3: 'h3', 4: 'h4' } as const;

/** How deep in the document a chart's title sits. */
type ChartHeadingLevel = keyof typeof HEADING_TAG;

/** What the frame tells the chart it wraps. */
export interface RechartsChartState {
  /**
   * Whether the plot may animate. Merged from the OS media query, the runtime
   * accessibility widget's stop-animations toggle and the host's forced
   * override, so a chart cannot animate past a reader who asked for stillness
   * through any of the three.
   */
  readonly isAnimationActive: boolean;
  /** The height the frame has reserved for the plot, in pixels. */
  readonly plotHeight: number;
}

interface RechartsChartProps {
  readonly title: string;
  /** The one-line insight the chart is for — the trend, not the numbers. */
  readonly caption: string;
  readonly config: ChartConfig;
  /**
   * The same figures as a real table. It is rendered on every pass and only
   * hidden visually, so assistive technology reaches it whether or not the
   * toggle has been pressed — a table built on demand would be absent exactly
   * when it is the only perceivable form of the chart.
   */
  readonly dataTable: React.ReactNode;
  /** A sentence naming what the plot shows, read as the chart region's name. */
  readonly ariaLabel?: string | undefined;
  /**
   * How deep the chart's title sits in the document outline. A chart drawn
   * inside a panel that already carries a title names the level below it, so
   * the outline states that the chart is inside that panel rather than beside
   * it.
   */
  readonly headingLevel?: ChartHeadingLevel | undefined;
  readonly isEmpty?: boolean | undefined;
  readonly emptyMessage?: string | undefined;
  readonly className?: string | undefined;
  readonly children: (state: RechartsChartState) => React.ReactNode;
}

/**
 * The accessible frame every dashboard chart is drawn inside: a figure whose
 * caption states the insight, a real data table one control away, and the
 * reduced-motion decision handed to the plot.
 *
 * Sibling of `chart.tsx` rather than a replacement — that one is the container
 * and tooltip a product screen already builds on. Like it, this file imports
 * nothing from the charting library: the plot is passed in, which keeps the
 * component package free of a dependency only its consumers need.
 */
function RechartsChart({
  title,
  caption,
  config,
  dataTable,
  ariaLabel,
  headingLevel,
  isEmpty = false,
  emptyMessage = 'Nothing to show for this range',
  className,
  children,
}: Readonly<RechartsChartProps>): React.JSX.Element {
  const Heading = HEADING_TAG[headingLevel ?? 3];
  const [tableShown, setTableShown] = React.useState(false);
  const isAnimationActive = !useReducedMotion();
  const titleId = React.useId();
  const summaryId = React.useId();
  // aria-labelledby wins over aria-label, so the region's name is built by
  // referencing the visible title and then the hidden summary, in that order.
  const labelledBy = ariaLabel === undefined ? titleId : `${titleId} ${summaryId}`;

  return (
    <figure
      data-slot="recharts-chart"
      aria-labelledby={titleId}
      className={cn('border-border bg-card m-0 rounded-md border p-3', className)}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <Heading id={titleId} className="text-muted-foreground text-xs font-semibold uppercase">
          {title}
        </Heading>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-xs underline"
          aria-expanded={tableShown}
          onClick={() => {
            setTableShown((shown) => !shown);
          }}
        >
          {tableShown ? 'Hide data' : 'Show data'}
        </button>
      </div>
      {isEmpty ? (
        <p className="text-muted-foreground py-6 text-center text-sm">{emptyMessage}</p>
      ) : (
        <>
          {ariaLabel !== undefined && (
            <span id={summaryId} className="sr-only">
              {ariaLabel}
            </span>
          )}
          {/* The reserved box is this element rather than the container inside
              it: the container builds its own style attribute out of the config's
              colours, and a second one passed in would replace them. */}
          <div data-slot="chart-plot-box" className="w-full" style={{ height: PLOT_HEIGHT }}>
            <ChartContainer
              config={config}
              className="h-full w-full"
              role="img"
              aria-labelledby={labelledBy}
            >
              {children({ isAnimationActive, plotHeight: PLOT_HEIGHT })}
            </ChartContainer>
          </div>
        </>
      )}
      {/* A region only while shown: a tab stop on a visually hidden box is a
          focus a sighted keyboard reader cannot see. */}
      {tableShown ? (
        <ScrollRegion
          label={`${title} data`}
          data-slot="chart-data-table"
          className="mt-2 overflow-x-auto rounded-sm text-sm"
        >
          {dataTable}
        </ScrollRegion>
      ) : (
        // No overflow class while hidden: it would override `sr-only`'s
        // `overflow: hidden`, and Chromium makes the overflowing 1px box a tab stop.
        <div data-slot="chart-data-table" className="sr-only mt-2 text-sm">
          {dataTable}
        </div>
      )}
      <figcaption className="text-muted-foreground mt-2 text-xs">{caption}</figcaption>
    </figure>
  );
}

export { RechartsChart };
