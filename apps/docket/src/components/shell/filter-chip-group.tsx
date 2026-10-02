import { cn } from '@hushbox/ui';
import type { JSX } from 'react';

interface FilterChipGroupProps<TValue extends string> {
  readonly label: string;
  readonly options: readonly TValue[];
  readonly selected: readonly TValue[];
  readonly onChange: (next: readonly TValue[]) => void;
}

/** One filter dimension: any of the values it holds, none of them by default. */
export function FilterChipGroup<TValue extends string>({
  label,
  options,
  selected,
  onChange,
}: FilterChipGroupProps<TValue>): JSX.Element {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-muted-foreground text-sm font-semibold uppercase">{label}</legend>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const on = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              onClick={() => {
                onChange(on ? selected.filter((value) => value !== option) : [...selected, option]);
              }}
              className={cn(
                'focus-visible:ring-ring rounded-full border px-2 py-0.5 text-sm outline-none focus-visible:ring-2',
                on
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted'
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
