import { cn } from '@hushbox/ui';
import { ChevronDown, Icon } from '@hushbox/ui/icons';
import { Swatch } from '@hushbox/ui/marks';
import { Chip } from './chip';
import type * as React from 'react';
import type { ModelSwatch } from '@hushbox/shared/design-tokens';

interface ModelChipProps {
  swatch: ModelSwatch;
  label: string;
  shortLabel?: string;
  /** How many further models are selected, as " + N"; it stays whole while the name truncates. */
  count?: string;
  expanded: boolean;
  onClick: () => void;
  id?: string;
  'data-testid'?: string;
}

/**
 * The label's padding makes room inside its clipped box for a descender that hangs below
 * the chip's one-em line, and the negative margin gives the room back, so the chip keeps
 * its size and the text its place.
 */
const MODEL_LABEL_CLASS = 'min-w-0 max-w-[18ch] truncate py-[0.25em] -my-[0.25em]';

/** The composer's model chip: the model's swatch, its name truncated, the count of any
 * further models whole, and a chevron. */
export function ModelChip({
  swatch,
  label,
  shortLabel,
  count,
  expanded,
  onClick,
  id,
  'data-testid': testId,
}: Readonly<ModelChipProps>): React.JSX.Element {
  const hasShortLabel = shortLabel !== undefined;
  return (
    <Chip
      id={id}
      data-testid={testId}
      expanded={expanded}
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label={`Model: ${label}${count ?? ''}`}
      className="min-w-14 shrink"
    >
      <Swatch swatch={swatch} />
      <span
        className={cn(MODEL_LABEL_CLASS, hasShortLabel && '@max-composer-compact/composer:hidden')}
      >
        {label}
      </span>
      {hasShortLabel ? (
        <span className={cn(MODEL_LABEL_CLASS, '@max-composer-compact/composer:inline hidden')}>
          {shortLabel}
        </span>
      ) : null}
      {count === undefined ? null : (
        <span data-slot="model-count" className="-ml-1.5 shrink-0 whitespace-pre">
          {count}
        </span>
      )}
      <Icon icon={ChevronDown} size="sm" className="shrink-0" />
    </Chip>
  );
}
