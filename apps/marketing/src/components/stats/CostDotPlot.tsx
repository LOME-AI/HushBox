import * as React from 'react';
import { formatUsd, type DotPlotEntry } from './compute-stats';

interface CostDotPlotProps {
  readonly entries: readonly DotPlotEntry[];
}

/**
 * Per-model average-cost dot plot on a shared log-scale axis. Each row's
 * name + cost text is the accessible alternative; the track and dot are
 * decorative positioning. The dot's `left` offset is layout, not color, so
 * an inline style is fine under the accessibility conventions.
 */
export function CostDotPlot({ entries }: CostDotPlotProps): React.JSX.Element {
  return (
    <ul aria-label="Average cost per model, log scale" className="flex flex-col gap-2">
      {entries.map((entry) => (
        <li key={entry.modelId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {/* Fixed (not content-sized) width keeps every row's track aligned;
              the md step lets desktop show full names while mobile keeps the
              narrow truncating column. The full name stays in the text node
              as the accessible alternative. */}
          <span className="text-foreground w-40 max-w-full min-w-0 shrink-0 truncate md:w-64">
            {entry.displayName}
          </span>
          {/* Its automatic minimum is the least track plus the cost, so a row too
              narrow for the name beside them wraps this whole unit below the name. */}
          <span className="flex flex-1 items-center gap-3">
            <span data-dot-track className="relative h-3 min-w-2 flex-1" aria-hidden="true">
              <span className="bg-border absolute top-1/2 right-0 left-0 h-px" />
              <span
                data-dot
                className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--key) forced-color-adjust-none"
                style={
                  {
                    left: `${String(entry.position)}%`,
                    '--key': entry.color,
                  } as React.CSSProperties
                }
              />
            </span>
            <span className="text-foreground min-w-20 shrink-0 text-right font-mono text-xs whitespace-nowrap tabular-nums">
              {formatUsd(entry.avgCostUsd)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
