import * as React from 'react';
import { clsx } from 'clsx';

import { cn } from '../../lib/utilities';
import { ScrollRegion } from '../composites/scroll-region';

/** Comfortable is the product's table; dense is the admin register's compact rhythm. */
type TableDensity = 'comfortable' | 'dense';

/** Whether a row or header cell sits in the table's head or its body. */
type TableSection = 'head' | 'body';

const DensityContext = React.createContext<TableDensity>('comfortable');
const SectionContext = React.createContext<TableSection>('body');

// A header cell keeps its type and colour outside the `cn` merge, so a caller's
// class overrides only its layout classes.
const DENSITY = {
  comfortable: {
    table: 'text-ui-sm',
    caption: 'px-3.5 pt-2.5 pb-1',
    columnHeaderType: 'text-caption text-muted-foreground font-semibold',
    columnHeader: 'px-3.5 py-2.5 whitespace-nowrap',
    cell: 'px-3.5 py-3 align-middle',
    bodyRow: 'hover:bg-accent',
  },
  dense: {
    table: 'text-ui',
    caption: 'px-2 pt-1',
    columnHeaderType: 'text-caption text-muted-foreground font-medium uppercase',
    columnHeader: 'px-2 py-1',
    cell: 'px-2 py-1',
    bodyRow: '',
  },
} as const satisfies Record<TableDensity, Record<string, string>>;

const NUMERIC_CELL = 'text-right font-mono tabular-nums';

// The wrapper draws the base layer's global focus outline, not the scroll
// region's ring: `outline-solid` displaces the region's `outline-hidden` in the
// merge and leaves width, colour and offset to the global rule.
const WRAPPER_FOCUS = 'focus-visible:ring-0 focus-visible:outline-solid';

/**
 * A semantic table in a bordered wrapper that scrolls sideways inside itself,
 * so a wide table never scrolls the page. While the table overflows it, the
 * wrapper is a tab stop named by the caption, so a keyboard reader can scroll
 * it; a caller's class on the table merges into the wrapper and wins over its
 * border, radius and fill.
 */
function Table({
  density = 'comfortable',
  caption,
  captionHidden = false,
  className,
  'data-testid': testId,
  children,
}: Readonly<{
  density?: TableDensity;
  /** What the table holds, in the screen's own words: its name and its scroll region's. */
  caption: string;
  /** Keep the caption for assistive technology only, when a heading beside the table names it. */
  captionHidden?: boolean;
  className?: string;
  /** Lands on the scroll wrapper, the element that holds the whole table. */
  'data-testid'?: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  const classes = DENSITY[density];
  return (
    <DensityContext.Provider value={density}>
      <ScrollRegion
        label={caption}
        tabStop="overflow"
        data-slot="table-wrapper"
        data-testid={testId}
        className={cn(
          'border-border bg-card overflow-x-auto rounded-lg border',
          WRAPPER_FOCUS,
          className
        )}
      >
        <table
          data-slot="table"
          data-density={density}
          className={clsx('w-full border-collapse text-left', classes.table)}
        >
          <caption
            className={clsx(
              'text-muted-foreground caption-top text-left',
              captionHidden ? 'sr-only' : classes.caption
            )}
          >
            {caption}
          </caption>
          {children}
        </table>
      </ScrollRegion>
    </DensityContext.Provider>
  );
}

function TableHead(props: Readonly<React.ComponentProps<'thead'>>): React.JSX.Element {
  return (
    <SectionContext.Provider value="head">
      <thead data-slot="table-head" {...props} />
    </SectionContext.Provider>
  );
}

function TableBody(props: Readonly<React.ComponentProps<'tbody'>>): React.JSX.Element {
  return (
    <SectionContext.Provider value="body">
      <tbody data-slot="table-body" {...props} />
    </SectionContext.Provider>
  );
}

function TableRow({
  className,
  ...props
}: Readonly<React.ComponentProps<'tr'>>): React.JSX.Element {
  const density = React.useContext(DensityContext);
  const section = React.useContext(SectionContext);
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-border border-b',
        section === 'body' && ['last:border-b-0', DENSITY[density].bodyRow],
        className
      )}
      {...props}
    />
  );
}

/**
 * A header cell: a column header in the head, a row header in the body. Its
 * scope follows where it sits unless the caller gives one.
 */
function TableHeaderCell({
  numeric = false,
  scope,
  className,
  ...props
}: Readonly<React.ComponentProps<'th'> & { numeric?: boolean }>): React.JSX.Element {
  const classes = DENSITY[React.useContext(DensityContext)];
  const section = React.useContext(SectionContext);
  const inHead = section === 'head';
  return (
    <th
      data-slot="table-header-cell"
      scope={scope ?? (inHead ? 'col' : 'row')}
      className={clsx(
        inHead ? classes.columnHeaderType : 'text-foreground font-medium',
        cn(
          inHead ? classes.columnHeader : classes.cell,
          'text-left',
          numeric && 'text-right',
          className
        )
      )}
      {...props}
    />
  );
}

function TableCell({
  numeric = false,
  className,
  ...props
}: Readonly<React.ComponentProps<'td'> & { numeric?: boolean }>): React.JSX.Element {
  const classes = DENSITY[React.useContext(DensityContext)];
  return (
    <td
      data-slot="table-cell"
      className={cn(classes.cell, numeric && NUMERIC_CELL, className)}
      {...props}
    />
  );
}

export { Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell, type TableDensity };
