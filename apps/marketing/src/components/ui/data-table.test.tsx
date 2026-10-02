import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DataTable, type DataTableProps } from './data-table';

const COMPARE: DataTableProps = {
  layout: 'compare',
  caption: 'How HushBox compares with your current AI chat app',
  columns: ['Your current AI chat app', 'HushBox'],
  rowHeaderLabel: 'Feature',
  rows: [
    {
      label: 'You hold the encryption key',
      cells: [
        { kind: 'no', text: 'No' },
        { kind: 'yes', text: 'Yes' },
      ],
    },
    {
      label: 'Source published',
      cells: [
        { kind: 'no', text: 'No' },
        { kind: 'yes', text: 'Yes' },
      ],
    },
  ],
  highlightColumn: 1,
  brandHead: true,
};

const STACK: DataTableProps = {
  layout: 'stack',
  caption: 'What we collect',
  columns: ['Collected', 'Shared'],
  rowHeaderLabel: 'Data',
  showRowHeaderLabel: true,
  rows: [
    { label: 'Email', cells: [{ kind: 'yes', text: 'Yes' }, 'To Resend, to send it'] },
    { label: 'Username', cells: ['Yes', { kind: 'no', text: 'No' }] },
  ],
};

function wrapperOf(container: HTMLElement): HTMLElement {
  const wrapper = container.querySelector<HTMLElement>('[data-slot="data-table"]');
  if (wrapper === null) throw new Error('no data table rendered');
  return wrapper;
}

function scrollBoxOf(container: HTMLElement): HTMLElement {
  const box = container.querySelector<HTMLElement>('[data-slot="table-wrapper"]');
  if (box === null) throw new Error('no table wrapper rendered');
  return box;
}

function bodyCellsOf(row: string): HTMLElement[] {
  const header = screen.getByRole('rowheader', { name: row });
  const tableRow = header.closest('tr');
  if (tableRow === null) throw new Error(`no row for ${row}`);
  return [...tableRow.querySelectorAll<HTMLElement>('td')];
}

describe('DataTable', () => {
  describe('in either layout', () => {
    it('names the table by its caption', () => {
      render(<DataTable {...COMPARE} />);
      expect(
        screen.getByRole('table', { name: 'How HushBox compares with your current AI chat app' })
      ).toBeInTheDocument();
    });

    it('keeps the caption for assistive technology only', () => {
      render(<DataTable {...STACK} />);
      expect(screen.getByText('What we collect')).toHaveClass('sr-only');
    });

    it('heads each row with its label as a row header', () => {
      render(<DataTable {...STACK} />);
      expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([
        'Email',
        'Username',
      ]);
    });

    it('heads each data column with its name', () => {
      render(<DataTable {...STACK} />);
      expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
        'Data',
        'Collected',
        'Shared',
      ]);
    });

    it('writes a word cell as its word', () => {
      render(<DataTable {...STACK} />);
      expect(bodyCellsOf('Email')[1]).toHaveTextContent('To Resend, to send it');
    });

    it('draws a value cell as a value mark', () => {
      render(<DataTable {...STACK} />);
      const mark = bodyCellsOf('Username')[1]?.querySelector('[data-slot="value-mark"]');
      expect(mark).toHaveAttribute('data-kind', 'no');
    });

    it('sits in a query container', () => {
      const { container } = render(<DataTable {...COMPARE} />);
      expect(wrapperOf(container)).toHaveClass('@container');
    });

    it('gives the query container no border, so it measures the table box', () => {
      const { container } = render(<DataTable {...COMPARE} />);
      expect(wrapperOf(container).className).not.toMatch(/\bborder/);
    });

    it('names its layout on the wrapper', () => {
      const { container } = render(<DataTable {...STACK} />);
      expect(wrapperOf(container)).toHaveAttribute('data-layout', 'stack');
    });

    it('scrolls sideways inside its own box, never the page', () => {
      const { container } = render(<DataTable {...COMPARE} />);
      expect(scrollBoxOf(container)).toHaveClass('overflow-x-auto');
    });

    it('lets head text wrap', () => {
      render(<DataTable {...COMPARE} />);
      expect(screen.getByRole('columnheader', { name: 'Your current AI chat app' })).toHaveClass(
        'whitespace-normal'
      );
    });

    it('marks no cell as highlighted without a highlighted column', () => {
      const { container } = render(<DataTable {...STACK} />);
      expect(container.querySelector('[data-highlight]')).toBeNull();
    });

    it('draws no rule under the head row', () => {
      const { container } = render(<DataTable {...STACK} />);
      expect(container.querySelector('thead tr')).toHaveClass('border-b-0');
    });

    it('draws a row header in the ui role', () => {
      render(<DataTable {...STACK} />);
      expect(screen.getByRole('rowheader', { name: 'Email' })).toHaveClass('text-ui');
    });
  });

  describe('the hidden first-column name', () => {
    it('keeps the row header column named for assistive technology', () => {
      render(<DataTable {...COMPARE} />);
      expect(screen.getByRole('columnheader', { name: 'Feature' })).toBeInTheDocument();
    });

    it('hides the name from sight', () => {
      render(<DataTable {...COMPARE} />);
      expect(screen.getByText('Feature')).toHaveClass('sr-only');
    });

    it('shows the name when asked to', () => {
      render(<DataTable {...STACK} />);
      expect(screen.getByText('Data')).not.toHaveClass('sr-only');
    });
  });

  describe('the highlighted column', () => {
    it('marks the column head as highlighted', () => {
      render(<DataTable {...COMPARE} />);
      expect(screen.getByRole('columnheader', { name: 'HushBox' })).toHaveAttribute(
        'data-highlight'
      );
    });

    it('marks every answer in the column as highlighted', () => {
      render(<DataTable {...COMPARE} />);
      for (const row of ['You hold the encryption key', 'Source published']) {
        expect(bodyCellsOf(row).map((cell) => cell.dataset['highlight'] !== undefined)).toEqual([
          false,
          true,
        ]);
      }
    });

    it('draws its answers in the brand red', () => {
      render(<DataTable {...COMPARE} />);
      expect(bodyCellsOf('Source published')[1]).toHaveClass('text-brand-red', 'font-semibold');
    });

    it('lets a highlighted answer glyph take the red of its cell', () => {
      render(<DataTable {...COMPARE} />);
      const glyph = bodyCellsOf('Source published')[1]?.querySelector('svg');
      expect(glyph).not.toHaveClass('text-success');
    });

    it('keeps the other answers glyphs in their own tone', () => {
      render(<DataTable {...COMPARE} />);
      const glyph = bodyCellsOf('Source published')[0]?.querySelector('svg');
      expect(glyph).toHaveClass('text-muted-foreground');
    });
  });

  describe('the compare layout', () => {
    it('tints the highlighted head', () => {
      render(<DataTable {...COMPARE} />);
      expect(screen.getByRole('columnheader', { name: 'HushBox' })).toHaveClass('bg-brand-red/8');
    });

    it('tints the highlighted answers more lightly than their head', () => {
      render(<DataTable {...COMPARE} />);
      expect(bodyCellsOf('Source published')[1]).toHaveClass('bg-brand-red/5');
    });

    it('sets the head text at the ui role leading', () => {
      render(<DataTable {...COMPARE} />);
      expect(screen.getByText('Your current AI chat app')).toHaveClass(
        'leading-(--text-ui--line-height)'
      );
    });

    it('sets the brand head text at the ui role leading', () => {
      render(<DataTable {...COMPARE} />);
      const head = screen.getByRole('columnheader', { name: 'HushBox' });
      expect(head.firstElementChild).toHaveClass('leading-(--text-ui--line-height)');
    });

    it('sets the head cells at the ui role leading', () => {
      render(<DataTable {...COMPARE} />);
      expect(screen.getByRole('columnheader', { name: 'Feature' })).toHaveClass(
        'leading-(--text-ui--line-height)'
      );
    });

    it('draws the head as a band', () => {
      render(<DataTable {...COMPARE} />);
      expect(screen.getByRole('columnheader', { name: 'Your current AI chat app' })).toHaveClass(
        'bg-muted'
      );
    });

    it('centres each answer cell under its column', () => {
      render(<DataTable {...COMPARE} />);
      expect(bodyCellsOf('Source published')[0]).toHaveClass('text-center');
    });

    it('centres each value mark in its cell', () => {
      render(<DataTable {...COMPARE} />);
      const mark = bodyCellsOf('Source published')[0]?.querySelector('[data-slot="value-mark"]');
      expect(mark).toHaveClass('justify-center');
    });

    it('draws the other answers in muted ink', () => {
      render(<DataTable {...COMPARE} />);
      expect(bodyCellsOf('Source published')[0]).toHaveClass('text-muted-foreground');
    });

    it('rounds and lifts its box off the page', () => {
      const { container } = render(<DataTable {...COMPARE} />);
      expect(scrollBoxOf(container)).toHaveClass('rounded-xl', 'shadow-xs', 'bg-transparent');
    });

    it('puts the logo in the highlighted head', () => {
      render(<DataTable {...COMPARE} />);
      const head = screen.getByRole('columnheader', { name: 'HushBox' });
      expect(head.querySelector('img')).not.toBeNull();
    });

    it('names the brand head by its column name alone', () => {
      render(<DataTable {...COMPARE} />);
      const head = screen.getByRole('columnheader', { name: 'HushBox' });
      expect(within(head).getByText('HushBox', { selector: '.sr-only' })).toBeInTheDocument();
    });

    it('hides the logo when the table is narrower than its tight width', () => {
      render(<DataTable {...COMPARE} />);
      const head = screen.getByRole('columnheader', { name: 'HushBox' });
      expect(head.querySelector('[data-testid="logo"]')).toHaveClass(
        '@max-mkt-compare-tight:[&>img]:hidden'
      );
    });

    it('tightens the cell padding when the table is narrower than its tight width', () => {
      render(<DataTable {...COMPARE} />);
      expect(bodyCellsOf('Source published')[0]).toHaveClass('@max-mkt-compare-tight:px-2');
    });

    it('shrinks the head text when the table is narrower than its tight width', () => {
      render(<DataTable {...COMPARE} />);
      expect(screen.getByText('Your current AI chat app')).toHaveClass(
        '@max-mkt-compare-tight:text-caption'
      );
    });

    it('draws no logo without the brand head', () => {
      render(<DataTable {...COMPARE} brandHead={false} />);
      const head = screen.getByRole('columnheader', { name: 'HushBox' });
      expect(head.querySelector('img')).toBeNull();
    });

    it('keeps its cells on the columns at every width', () => {
      render(<DataTable {...COMPARE} />);
      expect(bodyCellsOf('Source published')[0]?.className).not.toMatch(
        /grid-cols-1|wrap-break-word/
      );
    });

    it('labels no cell for stacking', () => {
      const { container } = render(<DataTable {...COMPARE} />);
      expect(container.querySelector('td[data-label]')).toBeNull();
    });
  });

  describe('the stack layout', () => {
    it('labels each cell with its column name for the stacked lines', () => {
      render(<DataTable {...STACK} />);
      expect(bodyCellsOf('Email').map((cell) => cell.dataset['label'])).toEqual([
        'Collected',
        'Shared',
      ]);
    });

    it('stacks each row into labelled lines below 768', () => {
      render(<DataTable {...STACK} />);
      expect(bodyCellsOf('Email')[0]).toHaveClass(
        'max-md:grid',
        'max-md:before:content-[attr(data-label)]'
      );
    });

    it('hides the column heads below 768, where each line carries its label', () => {
      const { container } = render(<DataTable {...STACK} />);
      expect(container.querySelector('thead')).toHaveClass('max-md:hidden');
    });

    it('left-aligns its cells', () => {
      render(<DataTable {...STACK} />);
      expect(bodyCellsOf('Email')[0]).toHaveClass('text-left');
    });

    it('draws a 2px border around its box', () => {
      const { container } = render(<DataTable {...STACK} />);
      expect(scrollBoxOf(container)).toHaveClass('border-2', 'rounded-lg');
    });

    it('aligns a value mark to the start of its cell', () => {
      render(<DataTable {...STACK} />);
      const mark = bodyCellsOf('Email')[0]?.querySelector('[data-slot="value-mark"]');
      expect(mark).toHaveClass('items-start');
    });

    it('tints its highlighted column head', () => {
      render(<DataTable {...STACK} highlightColumn={1} />);
      expect(screen.getByRole('columnheader', { name: 'Shared' })).toHaveClass('bg-brand-red/10');
    });

    it('sets its box in the interface face, whatever face surrounds it', () => {
      const { container } = render(<DataTable {...STACK} />);
      expect(scrollBoxOf(container)).toHaveClass('font-sans');
    });

    it('puts each label above its answer when the table is too narrow for both on one line', () => {
      render(<DataTable {...STACK} />);
      expect(bodyCellsOf('Email')[0]).toHaveClass('@max-mkt-stack-label-above:grid-cols-1');
    });

    it('wraps a long answer within its cell', () => {
      render(<DataTable {...STACK} />);
      expect(bodyCellsOf('Email')[1]).toHaveClass('max-md:wrap-break-word');
    });

    it('wraps a long row label within its line', () => {
      render(<DataTable {...STACK} />);
      expect(screen.getByRole('rowheader', { name: 'Email' })).toHaveClass(
        'max-md:wrap-break-word'
      );
    });

    it('tints its highlighted answers as deeply as their head', () => {
      render(<DataTable {...STACK} highlightColumn={1} />);
      expect(bodyCellsOf('Email')[1]).toHaveClass('bg-brand-red/10', 'text-brand-red');
    });
  });
});
