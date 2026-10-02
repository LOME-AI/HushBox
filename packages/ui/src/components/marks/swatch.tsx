import { cn } from '../../lib/utilities';
import type * as React from 'react';
import type { ModelSwatch } from '@hushbox/shared/design-tokens';

const SWATCH_CLASS: Readonly<Record<ModelSwatch, string>> = {
  1: 'bg-model-1',
  2: 'bg-model-2',
  3: 'bg-model-3',
  4: 'bg-model-4',
  5: 'bg-model-5',
  6: 'bg-model-6',
  7: 'bg-model-7',
  8: 'bg-model-8',
};

const SIZE_CLASS = { md: 'size-2', lg: 'size-2.5' } as const;

interface SwatchProps {
  swatch: ModelSwatch;
  size?: keyof typeof SIZE_CLASS;
}

/** A model's colour square. Decorative: the model's name always sits beside it. */
function Swatch({ swatch, size = 'md' }: Readonly<SwatchProps>): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-slot="swatch"
      className={cn('inline-block shrink-0 rounded-xs', SIZE_CLASS[size], SWATCH_CLASS[swatch])}
    />
  );
}

export { Swatch };
