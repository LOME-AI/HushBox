import * as React from 'react';

import { cn } from '../../../lib/utilities';

export interface PillRowOption<T extends string> {
  value: T;
  label: string;
}

export interface PillRowProps<T extends string> {
  options: readonly PillRowOption<T>[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
  ariaLabel?: string;
}

function getNeighborIndex<T extends string>(
  options: readonly PillRowOption<T>[],
  current: T,
  delta: 1 | -1
): number {
  const currentIndex = options.findIndex((o) => o.value === current);
  if (currentIndex === -1) {
    return 0;
  }
  return (currentIndex + delta + options.length) % options.length;
}

export function PillRow<T extends string>({
  options,
  value,
  onChange,
  className,
  ariaLabel,
}: Readonly<PillRowProps<T>>): React.JSX.Element {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const focusableIndex = selectedIndex === -1 ? 0 : selectedIndex;

  const move = (delta: 1 | -1): void => {
    const nextOption = options[getNeighborIndex(options, value, delta)];
    if (nextOption !== undefined) onChange(nextOption.value);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, optionValue: T): void => {
    switch (event.key) {
      case 'ArrowRight': {
        event.preventDefault();
        move(1);
        return;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        move(-1);
        return;
      }
      case ' ':
      case 'Enter': {
        event.preventDefault();
        onChange(optionValue);
        return;
      }
      default: {
        return;
      }
    }
  };

  return (
    <div
      role="radiogroup"
      data-slot="pill-row"
      {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
      className={cn('flex flex-wrap gap-1.5', className)}
    >
      {options.map((option, index) => {
        const isSelected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-slot="pill-row-item"
            data-state={isSelected ? 'on' : 'off'}
            aria-checked={isSelected}
            tabIndex={index === focusableIndex ? 0 : -1}
            onClick={() => {
              onChange(option.value);
            }}
            onKeyDown={(event) => {
              handleKeyDown(event, option.value);
            }}
            className={cn(
              'focus-visible:ring-ring/50 rounded-full px-3 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px]',
              isSelected
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/70'
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
