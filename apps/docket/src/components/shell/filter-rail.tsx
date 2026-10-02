import { Button, cn } from '@hushbox/ui';
import { CheckField } from '@hushbox/ui/field';
import { useFormFactor } from '@hushbox/ui/platform';
// The narrow path, never the package barrel: the barrel reaches the store and
// the citation index, whose node imports cannot load in a browser.
import { FINDING_STATUSES, KINDS, SEVERITIES } from '@hushbox/docket/types';
import { TEST_IDS } from '@/test-ids';
import { FilterChipGroup } from './filter-chip-group';
import { isFiltering } from './logic/filters';
import { useRailClosed } from './hooks/use-rail-closed';
import type { AreaOption, Filters } from './logic/filters';
import type { JSX } from 'react';

export interface FilterRailProps {
  readonly filters: Filters;
  readonly areas: readonly AreaOption[];
  readonly onChange: (patch: Partial<Filters>) => void;
  readonly onClear: () => void;
}

/** Full width while it is open on a narrow viewport: the queue is behind it. */
function railWidth(narrow: boolean, closed: boolean): string {
  if (closed) return 'w-auto';
  return narrow ? 'w-full' : 'w-56';
}

/** A folded rail must not hide that a filter is on, or a short queue reads as a finished one. */
function toggleLabel(closed: boolean, filtering: boolean): string {
  if (!closed) return 'Hide filters';
  return filtering ? 'Filters on' : 'Filters';
}

const AREA_ID = 'area-filter';
const WARNING_ID = 'warning-filter';
const GROUP_ID = 'group-filter';

/**
 * Areas are a select rather than chips: the corpus carries over two hundred
 * distinct values, many of them prose rather than a path, so one at a time is
 * the only reading that fits a rail.
 *
 * A rail this wide is most of a phone-sized viewport, and what is left is too
 * narrow to read a finding in, so a viewport below the shared mobile breakpoint
 * starts with the rail folded down to the control that opens it. On any
 * viewport the reader can fold it themselves, and their choice outlives the
 * reload. It stays in the flow rather than floating over the pane: an overlay
 * would cover the text the width was reclaimed for.
 */
export function FilterRail({ filters, areas, onChange, onClear }: FilterRailProps): JSX.Element {
  const narrow = useFormFactor().band === 'phone';
  const [closed, setClosed] = useRailClosed(narrow);

  return (
    <aside
      data-chrome=""
      data-testid={TEST_IDS.filterRail}
      aria-label="Filters"
      className={cn(
        'border-border flex shrink-0 flex-col overflow-y-auto border-r',
        closed ? 'gap-2 p-2' : 'gap-4 p-3',
        railWidth(narrow, closed)
      )}
    >
      <Button
        variant={closed ? 'default' : 'outline'}
        aria-expanded={!closed}
        onClick={() => {
          setClosed(!closed);
        }}
      >
        {toggleLabel(closed, isFiltering(filters))}
      </Button>
      {!closed && (
        <div className="flex flex-col gap-4">
          <FilterChipGroup
            label="Severity"
            options={SEVERITIES}
            selected={filters.severity}
            onChange={(severity) => {
              onChange({ severity });
            }}
          />
          <FilterChipGroup
            label="Status"
            options={FINDING_STATUSES}
            selected={filters.status}
            onChange={(status) => {
              onChange({ status });
            }}
          />
          <FilterChipGroup
            label="Kind"
            options={KINDS}
            selected={filters.kind}
            onChange={(kind) => {
              onChange({ kind });
            }}
          />

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={AREA_ID}
              className="text-muted-foreground flex items-center gap-2 text-sm leading-none font-semibold uppercase select-none"
            >
              Area
            </label>
            <select
              id={AREA_ID}
              data-testid={TEST_IDS.areaFilter}
              value={filters.area ?? ''}
              onChange={(event) => {
                onChange({ area: event.target.value === '' ? null : event.target.value });
              }}
              className="border-border bg-card text-foreground focus-visible:ring-ring w-full rounded-md border px-2 py-1 text-sm outline-none focus-visible:ring-2"
            >
              <option value="">All areas</option>
              {areas.map((area) => (
                <option key={area.value} value={area.value}>
                  {area.value} ({area.count})
                </option>
              ))}
            </select>
            {/* The dashboard counts the same areas over the work awaiting the
                reader in every section, so the two disagree by design. A number
                that names its scope reads as a second reading rather than as
                one of the two being wrong. */}
            <p className="text-muted-foreground text-sm">
              Counted in this section, with your other filters on.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <CheckField
              id={WARNING_ID}
              checked={filters.warning}
              onCheckedChange={(checked) => {
                onChange({ warning: checked });
              }}
              label="Has a warning"
            />
            <CheckField
              id={GROUP_ID}
              checked={filters.grouped}
              onCheckedChange={(checked) => {
                onChange({ grouped: checked });
              }}
              label="In a group"
            />
          </div>

          {isFiltering(filters) && (
            <Button variant="outline" onClick={onClear}>
              Clear all
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}
