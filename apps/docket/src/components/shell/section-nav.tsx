import { cn } from '@hushbox/ui';
import { TEST_IDS } from '@/test-ids';
import { SECTIONS } from './logic/sections';
import type { SectionId } from './logic/sections';
import type { JSX } from 'react';

interface SectionNavProps {
  readonly active: SectionId;
  /** Counted over the filtered set, so the tabs read as the work in front of you. */
  readonly counts: Record<SectionId, number>;
  readonly onSelect: (section: SectionId) => void;
}

export function SectionNav({ active, counts, onSelect }: SectionNavProps): JSX.Element {
  return (
    <nav
      data-testid={TEST_IDS.sectionNav}
      aria-label="Sections"
      // The padding is the focus ring's room: `overflow-x` makes this a scroll
      // container on both axes, and a ring drawn outside the button would be
      // clipped without it.
      className="flex min-w-0 items-center gap-1 overflow-x-auto p-1"
    >
      {SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          {...(section.id === active ? { 'aria-current': 'page' as const } : {})}
          onClick={() => {
            onSelect(section.id);
          }}
          className={cn(
            'focus-visible:ring-ring hover:bg-muted flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium outline-none focus-visible:ring-2',
            section.id === active ? 'bg-muted text-foreground' : 'text-muted-foreground'
          )}
        >
          {section.label}
          <span className="text-muted-foreground font-mono text-sm tabular-nums">
            {counts[section.id]}
          </span>
        </button>
      ))}
    </nav>
  );
}
