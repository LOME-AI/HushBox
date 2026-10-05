import { cn } from '@hushbox/ui';
import type * as React from 'react';

/**
 * The separator dot is drawn by the item it precedes, in the gap before it, so a wrapped
 * line starts on a dot rather than ending on one.
 */
const DOTTED_CLASS =
  'relative ms-[calc(0.625rem+3px)] before:absolute before:top-1/2 before:-start-[calc(0.625rem+3px)] before:-mt-[1.5px] before:size-[3px] before:rounded-full before:bg-current before:opacity-70';

export interface MetaItem {
  key: string;
  node: React.ReactNode;
}

/** Items on one wrapping line, each after the first drawn behind its separator dot. */
export function DottedLine({
  items,
  className,
}: Readonly<{ items: readonly MetaItem[]; className?: string }>): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1', className)}>
      {items.map(({ key, node }, index) => (
        <div key={key} className={index === 0 ? undefined : DOTTED_CLASS}>
          {node}
        </div>
      ))}
    </div>
  );
}
