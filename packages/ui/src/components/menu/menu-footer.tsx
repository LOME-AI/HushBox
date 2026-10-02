import type * as React from 'react';

/** A muted note under the items, such as what the choices cost or where they apply. */
export function MenuFooter({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="text-muted-foreground px-2 pt-2 pb-1 text-xs leading-[1.4]">{children}</div>
  );
}
