import * as React from 'react';
import { cn, Logo } from '@hushbox/ui';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@hushbox/ui/surface';
import { ValueMark, type ValueCell } from './value-mark';

type DataCell = string | ValueCell;

type DataTableLayout = 'compare' | 'stack';

interface DataTableProps {
  readonly layout: DataTableLayout;
  /** Names the table for assistive technology; the heading beside it names it on screen. */
  readonly caption: string;
  readonly columns: readonly string[];
  readonly rowHeaderLabel: string;
  readonly showRowHeaderLabel?: boolean;
  readonly rows: readonly { readonly label: string; readonly cells: readonly DataCell[] }[];
  /** An index into `columns`, not counting the row header column. */
  readonly highlightColumn?: number;
  /** Draws the logo beside the highlighted column's name. */
  readonly brandHead?: boolean;
}

interface Look {
  readonly box: string;
  readonly head: string;
  readonly body: string;
  readonly row: string;
  readonly headCell: string;
  readonly rowHeadCell: string;
  readonly headText: string;
  readonly highlightHeadCell: string;
  readonly highlightHeadText: string;
  readonly rowHeader: string;
  readonly cell: string;
  readonly highlightCell: string;
}

// `tight` is the table's own width, not the screen's: the query container is the
// borderless wrapper around the table's box.
const LOOKS: Readonly<Record<DataTableLayout, Look>> = {
  compare: {
    box: 'rounded-xl bg-transparent shadow-xs',
    head: '',
    body: '',
    row: 'hover:bg-transparent',
    headCell:
      'bg-muted px-5 py-[0.8125rem] text-center leading-(--text-ui--line-height) whitespace-normal @max-mkt-compare-tight:px-2',
    rowHeadCell: 'text-left',
    headText:
      'text-ui-sm leading-(--text-ui--line-height) font-semibold @max-mkt-compare-tight:text-caption',
    highlightHeadCell: 'bg-brand-red/8',
    highlightHeadText: 'text-ui leading-(--text-ui--line-height) text-brand-red font-bold',
    rowHeader: 'text-ui px-5 py-[0.8125rem] @max-mkt-compare-tight:px-2',
    cell: 'text-ui text-muted-foreground w-[26%] px-5 py-[0.8125rem] text-center @max-mkt-compare-tight:w-20 @max-mkt-compare-tight:px-2',
    highlightCell: 'bg-brand-red/5 text-brand-red font-semibold',
  },
  stack: {
    box: 'rounded-lg border-2 bg-transparent font-sans max-md:[&>table]:block',
    head: 'max-md:hidden',
    body: 'max-md:block',
    row: 'hover:bg-transparent max-md:block max-md:px-3 max-md:py-2.5',
    headCell: 'px-3 py-2 align-bottom whitespace-normal',
    rowHeadCell: '',
    headText: 'text-ui text-foreground font-semibold',
    highlightHeadCell: 'bg-brand-red/10',
    highlightHeadText: 'text-ui text-brand-red font-semibold',
    rowHeader:
      'text-ui px-3 py-2 align-top max-md:block max-md:p-0 max-md:pb-1.5 max-md:font-semibold max-md:wrap-break-word',
    cell: 'text-ui text-foreground px-3 py-2 text-left align-top max-md:grid max-md:grid-cols-[6.5rem_minmax(0,1fr)] max-md:gap-3 max-md:wrap-break-word @max-mkt-stack-label-above:grid-cols-1 @max-mkt-stack-label-above:gap-y-0.5 max-md:px-0 max-md:py-[0.2rem] max-md:before:content-[attr(data-label)] max-md:before:text-caption max-md:before:font-semibold max-md:before:text-muted-foreground max-md:before:pt-[0.1rem]',
    highlightCell: 'bg-brand-red/10 text-brand-red font-semibold',
  },
};

/** The highlighted column's name beside the logo, whose wordmark takes the head's type; the logo's own name stays out of the header's. */
function BrandHead({ name }: Readonly<{ name: string }>): React.JSX.Element {
  return (
    <>
      <span aria-hidden="true">
        <Logo className="@max-mkt-compare-tight:[&>img]:hidden inline-flex gap-1.5 [&>img]:size-4 [&>span]:[font:inherit]" />
      </span>
      <span className="sr-only">{name}</span>
    </>
  );
}

/**
 * A table of row labels against columns of answers, each a word or a value mark.
 * `compare` sets answers centred under their columns in a banded head; `stack`
 * left-aligns them and, below 768, turns each row into labelled lines.
 */
function DataTable({
  layout,
  caption,
  columns,
  rowHeaderLabel,
  showRowHeaderLabel = false,
  rows,
  highlightColumn,
  brandHead = false,
}: Readonly<DataTableProps>): React.JSX.Element {
  const look = LOOKS[layout];
  const highlight = (column: number): { 'data-highlight'?: '' } =>
    column === highlightColumn ? { 'data-highlight': '' } : {};

  return (
    <div data-slot="data-table" data-layout={layout} className="@container">
      <Table caption={caption} captionHidden className={look.box}>
        <TableHead className={look.head}>
          <TableRow className={cn(look.row, 'border-b-0')}>
            <TableHeaderCell className={cn(look.headCell, look.rowHeadCell)}>
              <span className={showRowHeaderLabel ? look.headText : 'sr-only'}>
                {rowHeaderLabel}
              </span>
            </TableHeaderCell>
            {columns.map((name, column) => {
              const highlighted = column === highlightColumn;
              return (
                <TableHeaderCell
                  key={name}
                  {...highlight(column)}
                  className={cn(look.headCell, highlighted && look.highlightHeadCell)}
                >
                  {highlighted && brandHead ? (
                    <span className={look.highlightHeadText}>
                      <BrandHead name={name} />
                    </span>
                  ) : (
                    <span className={highlighted ? look.highlightHeadText : look.headText}>
                      {name}
                    </span>
                  )}
                </TableHeaderCell>
              );
            })}
          </TableRow>
        </TableHead>
        <TableBody className={look.body}>
          {rows.map((row) => (
            <TableRow key={row.label} className={look.row}>
              <TableHeaderCell className={look.rowHeader}>{row.label}</TableHeaderCell>
              {row.cells.map((cell, column) => {
                const highlighted = column === highlightColumn;
                return (
                  <TableCell
                    key={columns[column] ?? column}
                    {...highlight(column)}
                    data-label={layout === 'stack' ? columns[column] : undefined}
                    className={cn(look.cell, highlighted && look.highlightCell)}
                  >
                    {typeof cell === 'string' ? (
                      cell
                    ) : (
                      <ValueMark
                        kind={cell.kind}
                        text={cell.text}
                        highlighted={highlighted}
                        centred={layout === 'compare'}
                      />
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export { DataTable, type DataTableProps, type DataCell };
