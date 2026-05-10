import * as React from 'react';
import { Circle, CircleDot } from 'lucide-react';

import { cn } from '../../../lib/utilities';

export interface FontCardProps {
  selected: boolean;
  purpose: string;
  fontName: string;
  fontFamily: string;
  onSelect: () => void;
  className?: string;
}

export function FontCard({
  selected,
  purpose,
  fontName,
  fontFamily,
  onSelect,
  className,
}: Readonly<FontCardProps>): React.JSX.Element {
  const Indicator = selected ? CircleDot : Circle;

  return (
    <button
      type="button"
      data-slot="font-card"
      data-state={selected ? 'on' : 'off'}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-[3px]',
        selected
          ? 'bg-accent text-accent-foreground border-primary'
          : 'border-input bg-background text-foreground hover:bg-accent/50 hover:text-accent-foreground',
        className
      )}
    >
      <Indicator
        aria-hidden
        data-slot="font-card-indicator"
        data-state={selected ? 'on' : 'off'}
        className={cn('size-4 shrink-0', selected ? 'text-primary' : 'text-muted-foreground')}
      />
      <span className="flex min-w-0 flex-col">
        {/* Inline fontFamily is intentional: this card previews the font itself —
            the whole point is showing the user how each option reads. */}
        <span
          data-slot="font-card-purpose"
          className="text-base leading-tight font-semibold"
          // eslint-disable-next-line no-restricted-syntax -- preview must use the actual font
          style={{ fontFamily }}
        >
          {purpose}
        </span>
        <span
          data-slot="font-card-name"
          className="text-muted-foreground text-xs leading-tight"
          // eslint-disable-next-line no-restricted-syntax -- preview must use the actual font
          style={{ fontFamily }}
        >
          {fontName}
        </span>
      </span>
    </button>
  );
}
