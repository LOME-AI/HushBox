import * as React from 'react';
import { cn } from '@hushbox/ui';
import { A11Y_FONT_OVERRIDE_CLASS } from '@hushbox/ui/accessibility';
import {
  MONO_TICK_CHARACTER_EM,
  WIDGET_FACE_TICK_CHARACTER_EM,
  Y_AXIS_TICKS,
  tickThresholds,
  type TrendBand,
  type XAxisTick,
} from './compute-stats';

interface TrendChartProps {
  readonly bands: readonly TrendBand[];
  readonly ticks: readonly XAxisTick[];
  readonly ariaLabel: string;
}

const GRIDLINES = Y_AXIS_TICKS.filter((tick) => tick !== 100 && tick !== 0);

/**
 * Container rules, per chart, for the tick row as it narrows: the last label
 * drops to a second line once the two edge labels cannot sit side by side, and
 * each interior tier hides below the width its labels need. Written here rather
 * than as utility classes because the widths are per chart; being in rem, a
 * larger text size raises them. A second set, scoped to the widget's font
 * override, derives the same widths from the widest face it can set.
 */
function tickVisibilityCss(scope: string, ticks: readonly XAxisTick[]): string {
  const faces = [
    { prefix: '', characterEm: MONO_TICK_CHARACTER_EM },
    { prefix: `html.${A11Y_FONT_OVERRIDE_CLASS} `, characterEm: WIDGET_FACE_TICK_CHARACTER_EM },
  ];
  return faces
    .flatMap(({ prefix, characterEm }) => {
      const thresholds = tickThresholds(ticks, characterEm);
      const row = `${prefix}[data-tick-scope="${scope}"]`;
      return [
        `@container not (min-width: ${String(thresholds.edges)}rem) { ${row} [data-tick-lines] { height: 2.25rem; } ${row} [data-tick-tier="edge"]:last-child { top: 1.25rem; } }`,
        ...(['alternate', 'dense'] as const).map(
          (tier) =>
            `@container not (min-width: ${String(thresholds[tier])}rem) { ${row} [data-tick-tier="${tier}"] { display: none; } }`
        ),
      ];
    })
    .join('\n');
}

/**
 * Hand-rolled 100%-stacked-area SVG (repo pattern, no chart library). The
 * geometry lives in compute-stats; this renders pre-built band paths in a
 * 100x100 viewBox stretched to the plot, with the percent axis, gridlines and
 * dated ticks laid over it in HTML so their text never stretches. The ranked
 * list below the chart is the text alternative for the per-model breakdown;
 * the aria-label summarises what the image shows, so both axes are hidden.
 */
export function TrendChart({ bands, ticks, ariaLabel }: TrendChartProps): React.JSX.Element {
  const chartId = React.useId();
  const gradientId = (index: number): string => `${chartId}-band-${String(index)}`;
  if (bands.length === 0) {
    return (
      <div className="text-muted-foreground flex h-48 w-full items-center justify-center rounded-md font-mono text-xs tracking-widest uppercase">
        Not enough data yet
      </div>
    );
  }
  return (
    <figure className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-2">
      <div aria-hidden="true" className="relative w-9">
        {Y_AXIS_TICKS.map((tick) => (
          <span
            key={tick}
            style={{ top: `${String(100 - tick)}%` }}
            className="text-muted-foreground absolute right-0 -translate-y-1/2 font-mono text-xs leading-none tabular-nums"
          >
            {`${String(tick)}%`}
          </span>
        ))}
      </div>
      <div className="border-border relative h-[clamp(12rem,10rem+6vw,15rem)] overflow-hidden rounded-md border">
        <svg
          role="img"
          aria-label={ariaLabel}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 block size-full"
        >
          <defs>
            {bands.map((band, index) => (
              // objectBoundingBox units: the fade spans exactly the band's own
              // vertical extent, strongest under its top line.
              <linearGradient key={band.id} id={gradientId(index)} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={band.color} stopOpacity="0.85" />
                <stop offset="1" stopColor={band.color} stopOpacity="0.4" />
              </linearGradient>
            ))}
          </defs>
          {bands.map((band, index) => (
            <path key={band.id} d={band.path} fill={`url(#${gradientId(index)})`} />
          ))}
          {bands
            .filter((band) => band.segments !== '')
            .map((band) => (
              <path
                key={band.id}
                d={band.segments}
                fill="none"
                stroke={band.color}
                strokeWidth={2}
                strokeLinejoin="round"
                // The 100x100 viewBox stretches non-uniformly; keep the line 2px on screen.
                vectorEffect="non-scaling-stroke"
              />
            ))}
        </svg>
        {GRIDLINES.map((tick) => (
          <div
            key={tick}
            data-gridline
            aria-hidden="true"
            style={{ top: `${String(100 - tick)}%` }}
            className="border-foreground/22 pointer-events-none absolute inset-x-0 h-0 border-t border-dashed"
          />
        ))}
      </div>
      <style>{tickVisibilityCss(chartId, ticks)}</style>
      <div aria-hidden="true" data-tick-scope={chartId} className="@container col-start-2">
        <div data-tick-lines className="relative h-4">
          {ticks.map((tick, index) => (
            <span
              key={tick.label}
              data-tick-tier={tick.tier}
              style={{ left: `${String(tick.position)}%` }}
              className={cn(
                'text-muted-foreground absolute top-0 font-mono text-xs tracking-widest whitespace-nowrap uppercase',
                index === ticks.length - 1 ? '-translate-x-full' : index > 0 && '-translate-x-1/2'
              )}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <ul aria-label="Legend" className="col-start-2 mt-1 flex flex-wrap gap-x-4.5 gap-y-1.5">
        {bands.map((band) => (
          <li key={band.id} className="text-foreground inline-flex items-center gap-2 text-sm">
            <svg viewBox="0 0 10 10" className="size-3 flex-none rounded-[3px]" aria-hidden="true">
              <rect width="10" height="10" fill={band.color} />
            </svg>
            {band.label}
          </li>
        ))}
      </ul>
    </figure>
  );
}
