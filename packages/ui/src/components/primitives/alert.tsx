import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utilities';

const ALERT_LAYOUT =
  'flex items-center gap-2 rounded-md p-3 text-sm [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0';

/** The four fill and ink pairs; the notice draws a dialog's alert from these too. */
const alertPair = cva('', {
  variants: {
    variant: { default: '', destructive: '' },
    emphasis: { subtle: '', strong: '' },
  },
  compoundVariants: [
    { variant: 'default', emphasis: 'subtle', class: 'text-muted-foreground' },
    { variant: 'default', emphasis: 'strong', class: 'bg-muted text-foreground' },
    { variant: 'destructive', emphasis: 'subtle', class: 'text-destructive' },
    { variant: 'destructive', emphasis: 'strong', class: 'bg-destructive/10 text-destructive' },
  ],
});

type AlertVariant = NonNullable<VariantProps<typeof alertPair>['variant']>;
type AlertEmphasis = NonNullable<VariantProps<typeof alertPair>['emphasis']>;

/**
 * The sole statement of the emphasis a variant carries when a call site names
 * none: the component reads its default from here rather than declaring its
 * own, so the exported styling function and the rendered element can never
 * disagree about what an unspecified emphasis means.
 */
function alertPairClasses({
  variant,
  emphasis,
}: {
  variant: AlertVariant;
  emphasis?: AlertEmphasis | undefined;
}): string {
  return alertPair({
    variant,
    emphasis: emphasis ?? (variant === 'destructive' ? 'strong' : 'subtle'),
  });
}

function alertVariants(options: {
  variant: AlertVariant;
  emphasis?: AlertEmphasis | undefined;
}): string {
  return cn(ALERT_LAYOUT, alertPairClasses(options));
}

/**
 * `variant` is required and carries the live-region semantics: `destructive`
 * is an assertive `role="alert"` that interrupts a screen reader mid-sentence,
 * `default` a polite `role="status"` that waits its turn. There is no default
 * variant, so a call site cannot interrupt the user without saying it meant to.
 *
 * `emphasis` is orthogonal and carries appearance only, so how loud an alert
 * looks can be raised or lowered without touching what it announces itself as.
 * It defaults to the weight its variant already implied.
 */
function Alert({
  className,
  variant,
  emphasis,
  ...props
}: React.ComponentProps<'div'> & {
  variant: AlertVariant;
  emphasis?: AlertEmphasis;
}): React.JSX.Element {
  return (
    <div
      role={variant === 'destructive' ? 'alert' : 'status'}
      className={cn(alertVariants({ variant, emphasis }), className)}
      {...props}
    />
  );
}

export { Alert, alertPairClasses, alertVariants };
