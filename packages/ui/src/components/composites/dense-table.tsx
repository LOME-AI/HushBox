import * as React from 'react';

import { cn } from '../../lib/utilities';
import { ScrollRegion } from './scroll-region';

interface DenseTableHeader {
  readonly label: string;
  readonly srOnly?: boolean;
}

/**
 * Dense table chrome: header styling plus the wide-table rule — the table
 * scrolls in its own container so the page never scrolls sideways, and that
 * container is a named tab stop so a keyboard reader can scroll it too.
 */
function DenseTable({
  testId,
  label,
  headers,
  className,
  children,
  ...props
}: Readonly<
  React.ComponentProps<'div'> & {
    testId: string;
    /** What the table holds, in the screen's own words: the scroll region's name. */
    label: string;
    headers: readonly DenseTableHeader[];
  }
>): React.JSX.Element {
  return (
    <ScrollRegion
      label={label}
      data-slot="dense-table"
      className={cn('overflow-x-auto', className)}
      {...props}
    >
      <table data-testid={testId} className="w-full text-left text-sm">
        <thead>
          <tr className="text-muted-foreground border-border border-b text-xs uppercase">
            {headers.map((header) => (
              <th key={header.label} className="py-1 pr-2 font-medium">
                {header.srOnly === true ? (
                  <span className="sr-only">{header.label}</span>
                ) : (
                  header.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </ScrollRegion>
  );
}

export { DenseTable };
