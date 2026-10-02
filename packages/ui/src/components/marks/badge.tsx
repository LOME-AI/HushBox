import { cn } from '../../lib/utilities';
import { Icon, type IconComponent } from '../icons/icon';
import type * as React from 'react';

/** What a badge says about its subject; callers map their own names onto these. */
type BadgeTone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'brand' | 'secondary';

/** A status tone is its ink on a 12% tint of the same tone, which clears 4.5:1 in both themes. */
const TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-muted text-muted-foreground',
  success: 'bg-success/12 text-success-text',
  warning: 'bg-warning/12 text-warning-text',
  error: 'bg-error/12 text-error-text',
  info: 'bg-info/12 text-info-text',
  brand: 'bg-primary text-primary-foreground',
  secondary: 'bg-secondary text-secondary-foreground',
};

/** How large a badge's type is: `compact` is the small uppercase tag set beside a line of text. */
type BadgeSize = 'default' | 'compact';

const SIZE_CLASS: Readonly<Record<BadgeSize, string>> = {
  default: 'px-2 py-0.5 text-xs font-medium',
  compact:
    'px-[0.4375rem] py-[0.0625rem] text-[0.625rem] leading-4 font-semibold tracking-[0.04em] uppercase',
};

/** Native attributes pass through; `className` and `style` do not, so the tone alone sets the look. */
type BadgeProps = Omit<React.ComponentProps<'span'>, 'className' | 'style'> & {
  tone: BadgeTone;
  size?: BadgeSize;
  children: React.ReactNode;
  icon?: IconComponent;
};

/** A small pill naming a status. */
function Badge({
  tone,
  size = 'default',
  children,
  icon,
  ...props
}: Readonly<BadgeProps>): React.JSX.Element {
  return (
    <span
      {...props}
      data-slot="badge"
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 rounded-full whitespace-nowrap',
        SIZE_CLASS[size],
        TONE_CLASS[tone]
      )}
    >
      {icon === undefined ? null : <Icon icon={icon} size="xs" />}
      {children}
    </span>
  );
}

export { Badge, type BadgeTone };
