import * as React from 'react';

/**
 * The band at the foot of a conversation that holds the composer: a hairline under the thread
 * and 1rem above and below the composer. The typing line's margin over the context gauge in
 * `typing-indicator.tsx` is derived from this hairline and top padding.
 */
export function InputDock({
  children,
  ...props
}: Readonly<Omit<React.ComponentProps<'div'>, 'className'>>): React.JSX.Element {
  return (
    <div {...props} className="bg-background flex-shrink-0 border-t py-4">
      {children}
    </div>
  );
}
