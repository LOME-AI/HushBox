import * as React from 'react';
import { cn } from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';

interface PillOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count?: number;
}

interface PillGroupProps<T extends string> {
  readonly label: string;
  readonly options: readonly PillOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly size?: 'sm' | 'md';
}

// `bare` sits outside the button's own touch floor, so the pill carries it.
const PILL_FRAME =
  'inline-flex items-center justify-center gap-1.5 rounded-full border text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color] pointer-coarse:min-h-11';

const PILL_SIZE: Record<'sm' | 'md', string> = {
  sm: 'h-8 px-3 shadow-xs',
  md: 'px-3.5 py-1.5',
};

const PILL_PRESSED = 'border-primary bg-primary text-primary-foreground';

const PILL_UNPRESSED =
  'border-border-control bg-background text-muted-foreground hover:bg-background-subtle';

export function PillGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  size = 'md',
}: PillGroupProps<T>): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option) => {
        const pressed = option.value === value;
        return (
          <Button
            key={option.value}
            variant="bare"
            aria-pressed={pressed}
            // A count moves with the data behind it, so a pill showing one is
            // counted under its label alone: the click name its visible text
            // would derive is then one the build's growth index never lists.
            data-track={option.count === undefined ? undefined : option.label}
            className={cn(PILL_FRAME, PILL_SIZE[size], pressed ? PILL_PRESSED : PILL_UNPRESSED)}
            onClick={() => {
              onChange(option.value);
            }}
          >
            <span>{option.label}</span>
            {option.count !== undefined && <span className="tabular-nums">{option.count}</span>}
          </Button>
        );
      })}
    </div>
  );
}
