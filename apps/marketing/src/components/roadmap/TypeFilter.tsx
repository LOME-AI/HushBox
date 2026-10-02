import * as React from 'react';
import { Circle, CircleCheck, Icon, RotateCw, type IconComponent } from '@hushbox/ui/icons';
import { PillGroup } from '../ui/pill-group';
import type { TypeFilterValue } from './types';

interface TypeFilterProps {
  readonly type: TypeFilterValue;
  readonly counts: Readonly<Record<TypeFilterValue, number>>;
  readonly onChange: (type: TypeFilterValue) => void;
}

interface LegendEntry {
  readonly icon: IconComponent;
  readonly colour: string;
  readonly label: string;
}

const LEGEND: readonly LegendEntry[] = [
  { icon: RotateCw, colour: 'text-primary', label: 'In progress' },
  { icon: Circle, colour: 'text-info', label: 'Planned' },
  { icon: CircleCheck, colour: 'text-success', label: 'Shipped' },
];

/**
 * The roadmap's one filter, by type, beside a key to the task status icons. The key
 * is hidden from assistive technology because every task row already says its
 * status in words.
 */
export function TypeFilter({ type, counts, onChange }: TypeFilterProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <PillGroup
        label="Type"
        size="sm"
        value={type}
        onChange={onChange}
        options={[
          { value: 'all', label: 'All', count: counts.all },
          { value: 'feature', label: 'Features', count: counts.feature },
          { value: 'bug', label: 'Bugs', count: counts.bug },
        ]}
      />
      <p
        aria-hidden="true"
        data-roadmap-legend
        className="text-ui-sm text-muted-foreground flex flex-wrap gap-x-4 gap-y-1.5"
      >
        {LEGEND.map(({ icon, colour, label }) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <Icon icon={icon} className={colour} />
            {label}
          </span>
        ))}
      </p>
    </div>
  );
}
