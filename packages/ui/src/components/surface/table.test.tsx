import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { render, screen } from '@testing-library/react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  type TableDensity,
} from './table';

function Deposits({
  density,
  className,
  captionHidden,
}: Readonly<{
  density?: TableDensity;
  className?: string;
  captionHidden?: boolean;
}>): React.JSX.Element {
  return (
    <Table
      caption="Purchase history"
      {...(density === undefined ? {} : { density })}
      {...(className === undefined ? {} : { className })}
      {...(captionHidden === undefined ? {} : { captionHidden })}
    >
      <TableHead>
        <TableRow>
          <TableHeaderCell>Date</TableHeaderCell>
          <TableHeaderCell numeric>Amount</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        <TableRow>
          <TableHeaderCell>2026-09-18</TableHeaderCell>
          <TableCell numeric>+$25.00</TableCell>
        </TableRow>
        <TableRow>
          <TableHeaderCell>2026-09-02</TableHeaderCell>
          <TableCell>Deposit</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

/** A resize observer the test fires by hand, standing in for the browser's layout. */
class ManualResizeObserver implements ResizeObserver {
  static readonly instances: ManualResizeObserver[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    ManualResizeObserver.instances.push(this);
  }
  observe(): void {
    /* the test fires it */
  }
  unobserve(): void {
    /* the test fires it */
  }
  disconnect(): void {
    /* nothing to release */
  }
  fire(): void {
    this.callback([], this);
  }
}

/** Lays every element out with a table this many pixels wide inside a 300px wrapper. */
function layOutTableWidth(width: number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
}

function resize(): void {
  for (const observer of ManualResizeObserver.instances) observer.fire();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  ManualResizeObserver.instances.length = 0;
});

function wrapper(): HTMLElement {
  return screen.getByRole('group', { name: 'Purchase history' });
}

function table(): HTMLElement {
  return screen.getByRole('table', { name: 'Purchase history' });
}

describe('Table', () => {
  describe('structure', () => {
    it('names the table by its caption', () => {
      render(<Deposits />);

      expect(table().querySelector('caption')).toHaveTextContent('Purchase history');
    });

    it('shows the caption by default', () => {
      render(<Deposits />);

      expect(table().querySelector('caption')).not.toHaveClass('sr-only');
    });

    it('keeps a hidden caption for assistive technology only', () => {
      render(<Deposits captionHidden />);

      expect(table().querySelector('caption')).toHaveClass('sr-only');
    });

    it('scopes a header cell in the head to its column', () => {
      render(<Deposits />);

      expect(screen.getByRole('columnheader', { name: 'Date' })).toHaveAttribute('scope', 'col');
    });

    it('scopes a header cell in the body to its row', () => {
      render(<Deposits />);

      expect(screen.getByRole('rowheader', { name: '2026-09-18' })).toHaveAttribute('scope', 'row');
    });
  });

  describe('wrapper', () => {
    it('scrolls the table sideways inside itself', () => {
      render(<Deposits />);

      expect(wrapper()).toHaveClass('overflow-x-auto');
    });

    it('is a tab stop while the table is wider than it, so a keyboard reader can scroll it', () => {
      vi.stubGlobal('ResizeObserver', ManualResizeObserver);
      layOutTableWidth(420);
      render(<Deposits />);

      expect(wrapper()).toHaveAttribute('tabindex', '0');
    });

    it('is no tab stop while the table fits, since there is nothing to scroll', () => {
      vi.stubGlobal('ResizeObserver', ManualResizeObserver);
      layOutTableWidth(300);
      render(<Deposits />);

      expect(wrapper()).not.toHaveAttribute('tabindex');
    });

    it('becomes a tab stop when a resize makes the table overflow', () => {
      vi.stubGlobal('ResizeObserver', ManualResizeObserver);
      layOutTableWidth(300);
      render(<Deposits />);

      layOutTableWidth(420);
      resize();

      expect(wrapper()).toHaveAttribute('tabindex', '0');
    });

    it('stops being a tab stop when a resize ends the overflow', () => {
      vi.stubGlobal('ResizeObserver', ManualResizeObserver);
      layOutTableWidth(420);
      render(<Deposits />);

      layOutTableWidth(300);
      resize();

      expect(wrapper()).not.toHaveAttribute('tabindex');
    });

    it('is a tab stop in server HTML, so a reader without script can still scroll it', () => {
      const html = renderToString(<Deposits />);

      expect(html).toMatch(/<div[^>]*tabindex="0"[^>]*data-slot="table-wrapper"/);
    });

    it('draws the global focus outline in place of a ring', () => {
      render(<Deposits />);

      expect(wrapper()).toHaveClass('focus-visible:outline-solid', 'focus-visible:ring-0');
      expect(wrapper()).not.toHaveClass('focus-visible:outline-hidden', 'focus-visible:ring-2');
    });

    it('holds the table', () => {
      render(<Deposits />);

      expect(table().parentElement).toBe(wrapper());
    });

    it('draws a border, the card radius and the paper fill by default', () => {
      render(<Deposits />);

      expect(wrapper()).toHaveClass('border', 'rounded-lg', 'bg-card');
    });

    it("lets a caller's class replace the border, radius and fill", () => {
      render(<Deposits className="rounded-none border-0 bg-transparent" />);

      expect(wrapper()).toHaveClass('rounded-none', 'border-0', 'bg-transparent');
      expect(wrapper()).not.toHaveClass('border', 'rounded-lg', 'bg-card');
    });

    it('carries a test id given to the table', () => {
      render(
        <Table caption="Purchase history" data-testid="purchase-table">
          <TableBody>
            <TableRow>
              <TableCell>$1</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );

      expect(screen.getByTestId('purchase-table')).toBe(wrapper());
    });

    it("keeps the scroll behaviour when a caller's class is merged in", () => {
      render(<Deposits className="border-0" />);

      expect(wrapper()).toHaveClass('overflow-x-auto');
    });
  });

  describe('density', () => {
    it('is comfortable by default', () => {
      render(<Deposits />);

      expect(table()).toHaveAttribute('data-density', 'comfortable');
    });

    it('sets comfortable rows in the small UI size', () => {
      render(<Deposits density="comfortable" />);

      expect(table()).toHaveClass('text-ui-sm');
    });

    it('pads comfortable header cells as the kit does', () => {
      render(<Deposits density="comfortable" />);

      expect(screen.getByRole('columnheader', { name: 'Date' })).toHaveClass('px-3.5', 'py-2.5');
    });

    it('pads comfortable body cells as the kit does', () => {
      render(<Deposits density="comfortable" />);

      expect(screen.getByRole('cell', { name: 'Deposit' })).toHaveClass('px-3.5', 'py-3');
    });

    it('highlights a comfortable body row under the pointer', () => {
      render(<Deposits density="comfortable" />);

      expect(screen.getByRole('cell', { name: 'Deposit' }).parentElement).toHaveClass(
        'hover:bg-accent'
      );
    });

    it('sets dense rows in the UI size', () => {
      render(<Deposits density="dense" />);

      expect(table()).toHaveClass('text-ui');
    });

    it('sets dense header cells in small muted capitals', () => {
      render(<Deposits density="dense" />);

      expect(screen.getByRole('columnheader', { name: 'Date' })).toHaveClass(
        'text-caption',
        'text-muted-foreground',
        'uppercase'
      );
    });

    it('pads dense cells tightly', () => {
      render(<Deposits density="dense" />);

      expect(screen.getByRole('cell', { name: 'Deposit' })).toHaveClass('px-2', 'py-1');
    });

    it('leaves a dense body row without a pointer highlight', () => {
      render(<Deposits density="dense" />);

      expect(screen.getByRole('cell', { name: 'Deposit' }).parentElement).not.toHaveClass(
        'hover:bg-accent'
      );
    });
  });

  describe('rows', () => {
    it('rules a line under each body row but the last', () => {
      render(<Deposits />);

      expect(screen.getByRole('cell', { name: 'Deposit' }).parentElement).toHaveClass(
        'border-b',
        'last:border-b-0'
      );
    });

    it('rules a line under the header row', () => {
      render(<Deposits />);

      expect(screen.getByRole('columnheader', { name: 'Date' }).parentElement).toHaveClass(
        'border-b'
      );
    });
  });

  describe('numbers', () => {
    it('right-aligns a numeric cell in tabular mono figures', () => {
      render(<Deposits />);

      expect(screen.getByRole('cell', { name: '+$25.00' })).toHaveClass(
        'text-right',
        'font-mono',
        'tabular-nums'
      );
    });

    it('right-aligns a numeric column header', () => {
      render(<Deposits />);

      expect(screen.getByRole('columnheader', { name: 'Amount' })).toHaveClass('text-right');
    });

    it('left-aligns a cell that is not numeric', () => {
      render(<Deposits />);

      expect(screen.getByRole('cell', { name: 'Deposit' })).not.toHaveClass('text-right');
    });
  });

  describe('native attributes pass through', () => {
    it('puts a data-label and a class given to a cell on the td', () => {
      render(
        <Table caption="Grid">
          <TableBody>
            <TableRow>
              <TableCell data-label="Amount" className="stack-cell">
                $1
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );

      const cell = screen.getByRole('cell', { name: '$1' });
      expect(cell.tagName).toBe('TD');
      expect(cell).toHaveAttribute('data-label', 'Amount');
      expect(cell).toHaveClass('stack-cell');
    });

    it("puts a caller's scope on the th", () => {
      render(
        <Table caption="Grid">
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="colgroup">Plans</TableHeaderCell>
            </TableRow>
          </TableHead>
        </Table>
      );

      expect(screen.getByRole('columnheader', { name: 'Plans' })).toHaveAttribute(
        'scope',
        'colgroup'
      );
    });

    it("merges a caller's class into a header cell", () => {
      render(
        <Table caption="Grid">
          <TableHead>
            <TableRow>
              <TableHeaderCell className="w-1/3">Plans</TableHeaderCell>
            </TableRow>
          </TableHead>
        </Table>
      );

      expect(screen.getByRole('columnheader', { name: 'Plans' })).toHaveClass('w-1/3', 'px-3.5');
    });

    it('puts data and aria attributes given to a row on the tr', () => {
      render(
        <Table caption="Grid">
          <TableBody>
            <TableRow data-testid="row" aria-selected="true" className="row-class">
              <TableCell>$1</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );

      const row = screen.getByTestId('row');
      expect(row.tagName).toBe('TR');
      expect(row).toHaveAttribute('aria-selected', 'true');
      expect(row).toHaveClass('row-class', 'border-b');
    });

    it('puts attributes given to the head on the thead', () => {
      render(
        <Table caption="Grid">
          <TableHead data-testid="head" className="head-class">
            <TableRow>
              <TableHeaderCell>Plans</TableHeaderCell>
            </TableRow>
          </TableHead>
        </Table>
      );

      const head = screen.getByTestId('head');
      expect(head.tagName).toBe('THEAD');
      expect(head).toHaveClass('head-class');
    });

    it('puts attributes given to the body on the tbody', () => {
      render(
        <Table caption="Grid">
          <TableBody data-testid="body" aria-live="polite">
            <TableRow>
              <TableCell>$1</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );

      const body = screen.getByTestId('body');
      expect(body.tagName).toBe('TBODY');
      expect(body).toHaveAttribute('aria-live', 'polite');
    });
  });
});
