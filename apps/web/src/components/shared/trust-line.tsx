import { Icon, type IconComponent } from '@hushbox/ui/icons';
import type * as React from 'react';
import type { TypeRole } from '@hushbox/shared/design-tokens';

type TrustLineSize = Extract<TypeRole, 'caption' | 'ui-sm'>;

interface TrustLineProps {
  icon: IconComponent;
  children: React.ReactNode;
  align?: 'center' | 'start';
  size?: TrustLineSize;
}

const ALIGN_CLASS = { center: 'text-center', start: 'text-start' } as const;

/** Each size takes its type role's font size; the line height stays the caption role's. */
const SIZE_CLASS: Readonly<Record<TrustLineSize, string>> = {
  caption: 'text-caption',
  'ui-sm': 'text-ui-sm leading-(--text-caption--line-height)',
};

/**
 * A privacy promise in one muted line, led by a green icon. The icon sits inline in the
 * text rather than beside a text block, so on a wrapped line it stays on the first line:
 * the ruled exception to centring an icon on its whole text block.
 */
export function TrustLine({
  icon,
  children,
  align = 'start',
  size = 'caption',
}: Readonly<TrustLineProps>): React.JSX.Element {
  return (
    <p
      className={`${SIZE_CLASS[size]} text-muted-foreground block text-balance ${ALIGN_CLASS[align]}`}
    >
      <Icon icon={icon} size="sm" className="text-success me-1.5 inline-block align-[-0.15em]" />
      {children}
    </p>
  );
}
