import { Button } from '../primitives/button';
import { Skeleton } from '../primitives/skeleton';
import type * as React from 'react';

/** One placeholder mark, drawn in the shape of what the region will hold. */
type SkeletonShape =
  | { kind: 'line'; width: `${number}%` }
  | { kind: 'block'; height: 'sm' | 'md' | 'lg' }
  | { kind: 'circle' };

const BLOCK_HEIGHT = { sm: 'h-12', md: 'h-24', lg: 'h-48' } as const;

function SkeletonMark({ shape }: Readonly<{ shape: SkeletonShape }>): React.JSX.Element {
  switch (shape.kind) {
    case 'line': {
      return <Skeleton className="h-3" style={{ width: shape.width }} />;
    }
    case 'block': {
      return <Skeleton className={`${BLOCK_HEIGHT[shape.height]} w-full`} />;
    }
    case 'circle': {
      return <Skeleton className="size-7 shrink-0 rounded-full" />;
    }
  }
}

/**
 * A region that loads on its own: skeleton marks in the shape of its content
 * while pending, an error line with an optional retry when the read failed, and
 * its children once ready. It is a named group so its busy state has an object
 * a screen reader can report; the skeletons stop pulsing under reduced motion.
 */
function AsyncRegion({
  status,
  label,
  placeholder,
  error,
  children,
}: Readonly<{
  status: 'pending' | 'error' | 'ready';
  /** What the region holds, in the screen's own words: its accessible name. */
  label: string;
  placeholder: readonly SkeletonShape[];
  error?: { message: string; onRetry?: () => void };
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      aria-busy={status === 'pending' ? true : undefined}
      data-slot="async-region"
      data-status={status}
    >
      {status === 'pending' && (
        <div
          data-slot="async-region-placeholder"
          aria-hidden="true"
          className="flex flex-col gap-2"
        >
          {placeholder.map((shape, index) => (
            <SkeletonMark key={index} shape={shape} />
          ))}
        </div>
      )}
      {status === 'error' && (
        <div data-slot="async-region-error" className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p role="alert" className="text-destructive text-ui">
            {error?.message ?? "Couldn't load this."}
          </p>
          {error?.onRetry !== undefined && (
            <Button variant="outline" size="sm" onClick={error.onRetry}>
              Try again
            </Button>
          )}
        </div>
      )}
      {status === 'ready' && children}
    </div>
  );
}

export { AsyncRegion, type SkeletonShape };
