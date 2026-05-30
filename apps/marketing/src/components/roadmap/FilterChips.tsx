import * as React from 'react';
import { cn } from '@hushbox/ui';
import type { FilterStatus, FilterType } from './use-filter-state';

interface FilterChipsProps {
  readonly statuses: ReadonlySet<FilterStatus>;
  readonly types: ReadonlySet<FilterType>;
  readonly statusCounts: Readonly<Record<FilterStatus, number>>;
  readonly typeCounts: Readonly<Record<FilterType, number>>;
  readonly onToggleStatus: (status: FilterStatus) => void;
  readonly onToggleType: (type: FilterType) => void;
}

const STATUS_ORDER: readonly FilterStatus[] = ['in_progress', 'planned', 'shipped'];
const TYPE_ORDER: readonly FilterType[] = ['feature', 'bug'];

const STATUS_LABELS: Record<FilterStatus, string> = {
  in_progress: 'Shipping now',
  planned: 'Up next',
  shipped: 'Shipped',
};

const TYPE_LABELS: Record<FilterType, string> = {
  feature: 'Features',
  bug: 'Bugs',
};

/**
 * Per-chip tone classes. Each chip carries its own colour so the
 * "shipping now" pill is red whether selected or not — only the fill /
 * outline state changes. Active = filled with tone, inactive = outlined
 * in the same tone with muted text. Selecting a colour and ditching
 * the leading icon keeps the pill width predictable across labels.
 */
const STATUS_TONES: Record<FilterStatus, { active: string; inactive: string }> = {
  in_progress: {
    active: 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
    inactive: 'border-primary/40 bg-background text-primary hover:bg-primary/10',
  },
  planned: {
    active: 'border-info bg-info text-white hover:bg-info/90',
    inactive: 'border-info/40 bg-background text-info hover:bg-info/10',
  },
  shipped: {
    active: 'border-success bg-success text-white hover:bg-success/90',
    inactive: 'border-success/40 bg-background text-success hover:bg-success/10',
  },
};

const TYPE_TONES: Record<FilterType, { active: string; inactive: string }> = {
  feature: {
    active: 'border-foreground bg-foreground text-background hover:bg-foreground/90',
    inactive: 'border-foreground/30 bg-background text-foreground hover:bg-foreground/10',
  },
  bug: {
    active: 'border-warning bg-warning text-white hover:bg-warning/90',
    inactive: 'border-warning/40 bg-background text-warning hover:bg-warning/10',
  },
};

/**
 * Two filter axes for the public roadmap board: status (which sections
 * appear) and type (which tasks appear inside cards). Each chip carries
 * its post-roll-up count so visitors can see what they'd hide before
 * clicking. Counts are stable across toggles — they describe the data
 * universe, not the current filter view.
 *
 * Chip groups behave as units: on narrow viewports they drop to the
 * next line as a whole row, not one chip at a time.
 */
export function FilterChips({
  statuses,
  types,
  statusCounts,
  typeCounts,
  onToggleStatus,
  onToggleType,
}: FilterChipsProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-roadmap-filters>
      <div role="group" aria-label="Status" className="flex flex-wrap items-center gap-3">
        <FilterAxisLabel>Status</FilterAxisLabel>
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_ORDER.map((value) => (
            <Chip
              key={value}
              active={statuses.has(value)}
              count={statusCounts[value]}
              label={STATUS_LABELS[value]}
              data-status={value}
              tone={STATUS_TONES[value]}
              onClick={() => {
                onToggleStatus(value);
              }}
            />
          ))}
        </div>
      </div>
      <div role="group" aria-label="Type" className="flex flex-wrap items-center gap-3">
        <FilterAxisLabel>Type</FilterAxisLabel>
        <div className="flex flex-wrap items-center gap-2">
          {TYPE_ORDER.map((value) => (
            <Chip
              key={value}
              active={types.has(value)}
              count={typeCounts[value]}
              label={TYPE_LABELS[value]}
              data-type={value}
              tone={TYPE_TONES[value]}
              onClick={() => {
                onToggleType(value);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function FilterAxisLabel({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="text-foreground w-20 shrink-0 text-sm font-semibold tracking-[0.18em] uppercase">
      {children}
    </span>
  );
}

type ChipProps = Readonly<React.ComponentPropsWithoutRef<'button'>> & {
  readonly active: boolean;
  readonly count: number;
  readonly label: string;
  readonly tone: { active: string; inactive: string };
};

function Chip({ active, count, label, tone, className, ...rest }: ChipProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-2.5 rounded-full border px-4 py-2 text-base font-medium transition-colors',
        'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
        active ? tone.active : tone.inactive,
        className
      )}
      {...rest}
    >
      <span>{label}</span>
      <span
        className={cn(
          'inline-flex min-w-[1.75rem] items-center justify-center rounded-full border px-2 py-0.5 font-mono text-sm tabular-nums',
          active ? 'border-current/20 bg-black/10' : 'border-current/30 bg-current/10'
        )}
      >
        {count}
      </span>
    </button>
  );
}
