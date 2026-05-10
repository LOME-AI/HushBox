import * as React from 'react';
import { RotateCw } from 'lucide-react';

import { cn } from '../../../lib/utilities';

export interface CycleButtonProps<T extends string> {
  label: string;
  values: readonly T[];
  value: T;
  onChange: (next: T) => void;
  formatValue?: (v: T) => string;
  className?: string;
}

const identity = (v: string): string => v;

function getNeighborIndex(values: readonly string[], current: string, delta: 1 | -1): number {
  const currentIndex = values.indexOf(current);
  // Stale value not present in the list — restart from index 0 on next, or from last on prev.
  if (currentIndex === -1) {
    return delta === 1 ? 0 : values.length - 1;
  }
  return (currentIndex + delta + values.length) % values.length;
}

export function CycleButton<T extends string>({
  label,
  values,
  value,
  onChange,
  formatValue,
  className,
}: Readonly<CycleButtonProps<T>>): React.JSX.Element {
  const format = formatValue ?? identity;
  const formattedCurrent = format(value);

  const cycle = (delta: 1 | -1): void => {
    const next = values[getNeighborIndex(values, value, delta)];
    if (next !== undefined) onChange(next);
  };

  const jumpTo = (index: number): void => {
    const next = values[index];
    if (next !== undefined) onChange(next);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    switch (event.key) {
      case 'ArrowRight':
      case ' ':
      case 'Enter': {
        event.preventDefault();
        cycle(1);
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        cycle(-1);
        return;
      }
      case 'Home': {
        event.preventDefault();
        jumpTo(0);
        return;
      }
      case 'End': {
        event.preventDefault();
        jumpTo(values.length - 1);
        return;
      }
      default: {
        return;
      }
    }
  };

  return (
    <button
      type="button"
      data-slot="cycle-button"
      onClick={() => {
        cycle(1);
      }}
      onKeyDown={handleKeyDown}
      aria-label={`${label}: ${formattedCurrent}`}
      className={cn(
        'border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-ring/50 inline-flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px]',
        className
      )}
    >
      <span data-slot="cycle-button-label" className="text-muted-foreground">
        {label}
      </span>
      <span className="ml-auto inline-flex items-center gap-2">
        <span data-slot="cycle-button-value" className="relative grid">
          {/* Visible value, stacked on top of the longest ghost so width never shifts */}
          <span className="col-start-1 row-start-1 text-right">{formattedCurrent}</span>
          {values.map((v) => (
            <span
              key={v}
              data-slot="cycle-button-ghost"
              aria-hidden
              className="pointer-events-none invisible col-start-1 row-start-1 whitespace-nowrap"
            >
              {format(v)}
            </span>
          ))}
        </span>
        <RotateCw aria-hidden className="size-3.5 shrink-0 opacity-70" />
      </span>
    </button>
  );
}
