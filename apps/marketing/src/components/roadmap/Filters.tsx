import type { FilterState, FilterStatus, FilterType } from './use-filter-state';

interface FiltersProps {
  readonly state: FilterState;
}

const STATUS_LABELS: Record<FilterStatus, string> = {
  in_progress: 'In progress',
  planned: 'Planned',
  shipped: 'Shipped',
};

const TYPE_LABELS: Record<FilterType, string> = {
  feature: 'Features',
  bug: 'Bugs',
};

/**
 * Filter chip row. Multi-select on both axes; tapping a chip toggles it.
 * Toggling all chips off in an axis snaps that axis back to all-on (no
 * "empty" state — the user always sees something).
 *
 * Built on raw buttons rather than the shared ToggleGroup primitive because
 * the marketing app doesn't bundle Radix UI by default and one role-aware
 * button is cheaper than the polyfill.
 */
export function Filters({ state }: FiltersProps): React.JSX.Element {
  const { statuses, types, toggleStatus, toggleType } = state;

  return (
    <div
      data-chrome=""
      className="bg-background/80 sticky top-16 z-30 flex flex-wrap items-center gap-3 py-3 backdrop-blur"
    >
      <ChipGroup label="Status">
        {(['in_progress', 'planned', 'shipped'] as const).map((value) => (
          <Chip
            key={value}
            label={STATUS_LABELS[value]}
            active={statuses.has(value)}
            onClick={() => toggleStatus(value)}
          />
        ))}
      </ChipGroup>
      <span className="bg-border h-4 w-px self-center" aria-hidden="true" />
      <ChipGroup label="Type">
        {(['feature', 'bug'] as const).map((value) => (
          <Chip
            key={value}
            label={TYPE_LABELS[value]}
            active={types.has(value)}
            onClick={() => toggleType(value)}
          />
        ))}
      </ChipGroup>
    </div>
  );
}

function ChipGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      {children}
    </div>
  );
}

interface ChipProps {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}

function Chip({ label, active, onClick }: ChipProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border text-foreground-muted hover:text-foreground',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
