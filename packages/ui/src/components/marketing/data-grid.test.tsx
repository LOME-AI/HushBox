import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DataGrid } from './data-grid';

const COLUMNS = ['Feature', 'ChatGPT', 'HushBox'];
const ROWS = [
  { label: 'Encrypted', values: ['No', 'Yes'] },
  { label: 'Tracked', values: ['Yes', 'No'] },
];

describe('DataGrid', () => {
  it('renders column headers', () => {
    render(<DataGrid columns={COLUMNS} rows={ROWS} />);
    expect(screen.getByText('Feature')).toBeInTheDocument();
    expect(screen.getByText('ChatGPT')).toBeInTheDocument();
    expect(screen.getByText('HushBox')).toBeInTheDocument();
  });

  it('renders row labels', () => {
    render(<DataGrid columns={COLUMNS} rows={ROWS} />);
    expect(screen.getByText('Encrypted')).toBeInTheDocument();
    expect(screen.getByText('Tracked')).toBeInTheDocument();
  });

  it('renders cell values', () => {
    render(<DataGrid columns={COLUMNS} rows={ROWS} />);
    expect(screen.getAllByText('Yes')).toHaveLength(2);
    expect(screen.getAllByText('No')).toHaveLength(2);
  });

  it('has data-slot attribute', () => {
    render(<DataGrid columns={COLUMNS} rows={ROWS} data-testid="grid" />);
    expect(screen.getByTestId('grid')).toHaveAttribute('data-slot', 'data-grid');
  });

  it('highlights column when highlightColumn is set', () => {
    render(<DataGrid columns={COLUMNS} rows={ROWS} highlightColumn={2} data-testid="grid" />);
    expect(screen.getByTestId('grid')).toHaveAttribute('data-highlight-column', '2');
  });

  it('applies custom className', () => {
    render(<DataGrid columns={COLUMNS} rows={ROWS} className="custom-class" data-testid="grid" />);
    expect(screen.getByTestId('grid')).toHaveClass('custom-class');
  });

  it('uses table semantics', () => {
    render(<DataGrid columns={COLUMNS} rows={ROWS} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  describe('animated prop', () => {
    it('sets data-animated attribute when animated is true', () => {
      render(<DataGrid columns={COLUMNS} rows={ROWS} animated data-testid="grid" />);
      expect(screen.getByTestId('grid')).toHaveAttribute('data-animated');
    });

    it('sets data-visible to false initially', () => {
      render(<DataGrid columns={COLUMNS} rows={ROWS} animated data-testid="grid" />);
      expect(screen.getByTestId('grid')).toHaveAttribute('data-visible', 'false');
    });

    it('sets --row-delay CSS custom property on each row', () => {
      render(<DataGrid columns={COLUMNS} rows={ROWS} animated />);
      const tableRows = screen.getByRole('table').querySelectorAll('tbody tr');
      expect(tableRows[0]).toHaveStyle('--row-delay: 0ms');
      expect(tableRows[1]).toHaveStyle('--row-delay: 100ms');
    });

    it('does not set data-animated when animated is false', () => {
      render(<DataGrid columns={COLUMNS} rows={ROWS} data-testid="grid" />);
      expect(screen.getByTestId('grid')).not.toHaveAttribute('data-animated');
    });
  });

  describe('highlightColumn styling', () => {
    it('applies highlight classes to cells in the highlighted column', () => {
      render(<DataGrid columns={COLUMNS} rows={ROWS} highlightColumn={2} />);
      const cells = screen.getByRole('table').querySelectorAll('tbody td');
      // Column 2 maps to the 3rd td per row (label + value0 + value1)
      const highlightedCell = cells[2]; // First row, column index 2
      expect(highlightedCell).toHaveClass('bg-primary/10');
      expect(highlightedCell).toHaveClass('font-semibold');
    });

    it('applies highlight classes to the header in the highlighted column', () => {
      render(<DataGrid columns={COLUMNS} rows={ROWS} highlightColumn={2} />);
      const headers = screen.getByRole('table').querySelectorAll('thead th');
      expect(headers[2]).toHaveClass('bg-primary/10');
    });
  });
});
