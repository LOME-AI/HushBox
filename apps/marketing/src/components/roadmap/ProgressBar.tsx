import * as React from 'react';
import { cn } from '@hushbox/ui';

interface ProgressBarProps {
  readonly done: number;
  readonly total: number;
  readonly className?: string;
}

/**
 * Tiny progress bar with done/total fraction and rounded percentage. Used
 * on project cards. The percentage is derived from done/total only; the
 * caller decides what those numbers mean (we count top-level tasks shipped
 * over total top-level tasks in the roadmap pipeline).
 */
export function ProgressBar({ done, total, className }: ProgressBarProps): React.JSX.Element {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`${String(done)} of ${String(total)} tasks done`}
        data-percent={percent}
        className="bg-background-subtle h-1.5 w-full overflow-hidden rounded-full"
      >
        <div
          className="bg-primary h-full rounded-full transition-[width]"
          style={{ width: `${String(percent)}%` }}
        />
      </div>
      <div className="text-muted-foreground flex items-center justify-between text-xs font-medium">
        <span className="font-mono tabular-nums">
          {done} of {total} done
        </span>
        <span className="font-mono tabular-nums">{percent}%</span>
      </div>
    </div>
  );
}
