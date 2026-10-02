import * as React from 'react';
import { formatUsd } from './compute-stats';
import type { UsageStatsWindowStats } from '@hushbox/shared';

interface CostCardProps {
  readonly cost: UsageStatsWindowStats['cost'];
}

export function CostCard({ cost }: CostCardProps): React.JSX.Element {
  const average = formatUsd(cost.avgUsd);
  return (
    <div className="border-border bg-background-subtle/40 @container flex flex-col gap-4 rounded-lg border p-6">
      <div className="flex flex-col gap-1">
        {/* 0.72em is the widest advance any widget face gives a figure character (0.6em
            in the mono face, plus the widest widget letter spacing), so the figure keeps
            its 2.25rem until its characters would run past the card, then shrinks to fit. */}
        <span
          style={{ '--figure-chars': average.length } as React.CSSProperties}
          className="text-foreground font-mono text-[length:min(2.25rem,calc(100cqi/var(--figure-chars)/0.72))] leading-[1.1] whitespace-nowrap tabular-nums"
        >
          {average}
        </span>
        <span className="text-muted-foreground text-sm">average cost per message</span>
      </div>
      <dl className="flex flex-wrap gap-x-8 gap-y-3">
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
            median
          </dt>
          <dd className="text-foreground font-mono tabular-nums">{formatUsd(cost.medianUsd)}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground font-mono text-xs tracking-widest uppercase">p90</dt>
          <dd className="text-foreground font-mono tabular-nums">{formatUsd(cost.p90Usd)}</dd>
        </div>
      </dl>
    </div>
  );
}
