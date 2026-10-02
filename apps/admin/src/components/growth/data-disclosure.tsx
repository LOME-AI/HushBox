import * as React from 'react';
import { ScrollRegion } from '@hushbox/ui';

/**
 * The figures behind a drawing, as a real table one control away.
 *
 * The table is rendered on every pass and only hidden visually, so assistive
 * technology reaches it whether or not the control has been pressed — a table
 * built on demand would be absent exactly when it is the only perceivable form
 * of the drawing beside it. The control exists so that a reader who can see the
 * drawing and wants the numbers has a way to them that does not run through a
 * screen reader or an export.
 *
 * Only the shown table is a scroll region and a tab stop. The hidden one carries
 * no overflow class either: Chromium makes a scroller whose content overflows it
 * keyboard-focusable whatever its tabindex, which would be a stop nobody can see.
 */
export function DataDisclosure({
  label,
  table,
}: Readonly<{
  /** What the table holds, in the words of its own caption. */
  label: string;
  table: React.ReactNode;
}>): React.JSX.Element {
  const [shown, setShown] = React.useState(false);

  return (
    <>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-xs underline"
          aria-expanded={shown}
          onClick={() => {
            setShown((showing) => !showing);
          }}
        >
          {shown ? 'Hide data' : 'Show data'}
        </button>
      </div>
      {shown ? (
        <ScrollRegion
          data-slot="chart-data-table"
          label={label}
          className="mt-2 overflow-x-auto text-sm"
        >
          {table}
        </ScrollRegion>
      ) : (
        <div data-slot="chart-data-table" className="sr-only">
          {table}
        </div>
      )}
    </>
  );
}
