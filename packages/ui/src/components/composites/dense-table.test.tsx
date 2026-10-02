import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DenseTable } from './dense-table';

const ROW = (
  <tr>
    <td>row-cell</td>
  </tr>
);

describe('DenseTable', () => {
  it('names its scroll region by its label', () => {
    render(
      <DenseTable testId="dense" label="Subscribers" headers={[{ label: 'Id' }]}>
        {ROW}
      </DenseTable>
    );

    expect(screen.getByRole('group', { name: 'Subscribers' })).toBe(
      screen.getByTestId('dense').parentElement
    );
  });

  it('makes its scroll region a tab stop', () => {
    render(
      <DenseTable testId="dense" label="Subscribers" headers={[{ label: 'Id' }]}>
        {ROW}
      </DenseTable>
    );

    expect(screen.getByRole('group', { name: 'Subscribers' })).toHaveAttribute('tabindex', '0');
  });

  it('keeps its scroll region square, so the corner rows are not clipped', () => {
    render(
      <DenseTable testId="dense" label="Subscribers" headers={[{ label: 'Id' }]}>
        {ROW}
      </DenseTable>
    );

    const region = screen.getByRole('group', { name: 'Subscribers' });
    expect(region.className).not.toMatch(/(^|\s)rounded(-|\s|$)/);
  });

  // `sr-only` is absolutely positioned, so a header placed against an ancestor
  // outside the scroller lands past the table's right edge and widens the page.
  it('is the containing block of its screen-reader-only headers, so they scroll with the table', () => {
    render(
      <DenseTable testId="dense" label="Subscribers" headers={[{ label: 'Actions', srOnly: true }]}>
        {ROW}
      </DenseTable>
    );

    expect(screen.getByRole('group', { name: 'Subscribers' })).toHaveClass('relative');
  });

  it('renders the visible headers and the row children', () => {
    render(
      <DenseTable
        testId="dense"
        label="Subscribers"
        headers={[{ label: 'Id' }, { label: 'Email' }]}
      >
        {ROW}
      </DenseTable>
    );

    const table = screen.getByTestId('dense');
    expect(within(table).getByText('Id')).toBeInTheDocument();
    expect(within(table).getByText('Email')).toBeInTheDocument();
    expect(within(table).getByText('row-cell')).toBeInTheDocument();
  });

  it('keeps an sr-only header in the accessibility tree without visible text', () => {
    render(
      <DenseTable testId="dense" label="Subscribers" headers={[{ label: 'Actions', srOnly: true }]}>
        {ROW}
      </DenseTable>
    );

    expect(screen.getByText('Actions')).toHaveClass('sr-only');
  });

  it('scrolls the table in its own container so the page never scrolls sideways', () => {
    render(
      <DenseTable testId="dense" label="Subscribers" headers={[{ label: 'Id' }]}>
        {ROW}
      </DenseTable>
    );

    expect(screen.getByTestId('dense').parentElement).toHaveClass('overflow-x-auto');
  });

  it('has a data-slot attribute', () => {
    render(
      <DenseTable
        testId="dense"
        label="Subscribers"
        data-testid="wrapper"
        headers={[{ label: 'Id' }]}
      >
        {ROW}
      </DenseTable>
    );

    expect(screen.getByTestId('wrapper')).toHaveAttribute('data-slot', 'dense-table');
  });

  it('applies a custom className to the scroll container', () => {
    render(
      <DenseTable
        testId="dense"
        label="Subscribers"
        data-testid="wrapper"
        className="mt-2"
        headers={[]}
      >
        {ROW}
      </DenseTable>
    );

    const wrapper = screen.getByTestId('wrapper');
    expect(wrapper).toHaveClass('mt-2');
    expect(wrapper).toHaveClass('overflow-x-auto');
  });
});
