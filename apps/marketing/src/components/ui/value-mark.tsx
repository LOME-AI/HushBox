import * as React from 'react';
import { cn } from '@hushbox/ui';
import {
  AlertTriangle,
  CircleCheck,
  CircleX,
  Icon,
  Lock,
  type IconComponent,
} from '@hushbox/ui/icons';

type ValueKind = 'yes' | 'no' | 'warn' | 'lock';

interface ValueCell {
  readonly kind: ValueKind;
  readonly text: string;
}

const GLYPH: Readonly<Record<ValueKind, IconComponent>> = {
  yes: CircleCheck,
  no: CircleX,
  warn: AlertTriangle,
  lock: Lock,
};

const TONE: Readonly<Record<ValueKind, string>> = {
  yes: 'text-success',
  no: 'text-muted-foreground',
  warn: 'text-warning',
  lock: 'text-success',
};

interface ValueMarkProps extends ValueCell {
  /** A highlighted answer's glyph takes the ink of its cell rather than its own tone. */
  readonly highlighted?: boolean;
  /** Centre the glyph and the word under a column, for one-word answers. */
  readonly centred?: boolean;
}

/** An answer drawn as a glyph and its word, so the meaning never rests on colour or shape alone. */
function ValueMark({
  kind,
  text,
  highlighted = false,
  centred = false,
}: Readonly<ValueMarkProps>): React.JSX.Element {
  return (
    <span
      data-slot="value-mark"
      data-kind={kind}
      className={cn('inline-flex gap-1.5', centred ? 'items-center justify-center' : 'items-start')}
    >
      <Icon
        icon={GLYPH[kind]}
        size="sm"
        className={cn('shrink-0', !centred && 'mt-[0.15rem]', !highlighted && TONE[kind])}
      />
      <span>{text}</span>
    </span>
  );
}

export { ValueMark, type ValueKind, type ValueCell };
