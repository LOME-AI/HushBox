import { cn } from '../../lib/utilities';
import { SIMPLE_INPUT_CLASSES } from './simple-input-classes';
import type * as React from 'react';

type InlineInputProps = Omit<React.ComponentProps<'input'>, 'size'> &
  ({ 'aria-label': string } | { 'aria-labelledby': string });

/**
 * The plain input for a table cell or an in-row search, where a floating label has
 * no room. It has no visible label, so its type demands an accessible name.
 */
function InlineInput({ className, ...props }: Readonly<InlineInputProps>): React.JSX.Element {
  return (
    <input
      data-slot="inline-input"
      className={cn(
        SIMPLE_INPUT_CLASSES,
        'border-border-control pointer-coarse:min-h-11',
        className
      )}
      {...props}
    />
  );
}

export { InlineInput };
export type { InlineInputProps };
