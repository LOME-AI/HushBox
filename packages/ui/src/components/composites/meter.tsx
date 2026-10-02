import * as React from 'react';

import { cn } from '../../lib/utilities';

/**
 * A band the caller has already resolved. The bar takes the verdict rather than
 * bounds to compare the fill against: the label rounds to whole percent, so a
 * bar deciding its own band would decide it on a different number than whoever
 * else reads the same fill — which is how a bar once painted its top band with
 * no matching warning raised beside it.
 */
interface MeterLevel {
  /** Fill utility for this band. */
  readonly className: string;
  /** What the band means, so the band never rests on color alone. */
  readonly state: string;
}

function defaultLabel(percentage: number): string {
  return `${String(percentage)}%`;
}

/**
 * A labelled fill bar. The bar itself is decorative — the label carries the
 * reading, and the level name rides it as screen-reader text, so the bands are
 * never conveyed by color alone.
 */
function Meter({
  value,
  max,
  level,
  formatLabel = defaultLabel,
  className,
  ...props
}: Readonly<
  React.ComponentProps<'div'> & {
    value: number;
    max: number;
    level?: MeterLevel | undefined;
    formatLabel?: ((percentage: number) => string) | undefined;
  }
>): React.JSX.Element {
  const percentage = Math.round((value / max) * 100);
  const scale = Math.min(percentage, 100) / 100;

  return (
    <div
      data-slot="meter"
      data-state={level?.state}
      className={cn('flex items-center gap-2', className)}
      {...props}
    >
      <div
        data-slot="meter-track"
        aria-hidden="true"
        className="bg-muted h-2 flex-1 overflow-hidden rounded"
      >
        <div
          data-slot="meter-fill"
          className={cn(
            'h-full rounded transition-transform duration-300',
            level?.className ?? 'bg-primary'
          )}
          // Scale, not width: the browser composites a transform on the GPU.
          style={{ transformOrigin: 'left', transform: `scaleX(${String(scale)})` }}
        />
      </div>
      <span className="text-muted-foreground text-sm whitespace-nowrap">
        {formatLabel(percentage)}
        {level !== undefined && <span className="sr-only">, {level.state}</span>}
      </span>
    </div>
  );
}

export { Meter };
export type { MeterLevel };
