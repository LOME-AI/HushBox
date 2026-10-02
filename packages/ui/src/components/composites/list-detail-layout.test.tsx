import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListDetailLayout } from './list-detail-layout';

const IDS = ['first', 'second', 'third'];

function renderLayout(
  overrides: Partial<React.ComponentProps<typeof ListDetailLayout>> = {}
): ReturnType<typeof vi.fn> {
  const onSelect = vi.fn();
  render(
    <ListDetailLayout
      itemIds={IDS}
      selectedId="first"
      onSelect={onSelect}
      list={<p>the list</p>}
      detail={<p>the detail</p>}
      detailLabel="Row details"
      {...overrides}
    />
  );
  return onSelect;
}

describe('ListDetailLayout', () => {
  it('renders the list slot', () => {
    renderLayout();

    expect(screen.getByText('the list')).toBeInTheDocument();
  });

  it('renders the detail slot in a labeled region beside the list', () => {
    renderLayout();

    const detail = screen.getByRole('complementary', { name: 'Row details' });
    expect(detail).toHaveTextContent('the detail');
  });

  it('renders no detail region while the detail slot is empty', () => {
    renderLayout({ detail: undefined, selectedId: null });

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('steps to the next item on ArrowDown', async () => {
    const onSelect = renderLayout();

    await userEvent.keyboard('{ArrowDown}');

    expect(onSelect).toHaveBeenCalledWith('second');
  });

  it('steps to the previous item on ArrowUp', async () => {
    const onSelect = renderLayout({ selectedId: 'second' });

    await userEvent.keyboard('{ArrowUp}');

    expect(onSelect).toHaveBeenCalledWith('first');
  });

  it('clamps stepping at the last item', async () => {
    const onSelect = renderLayout({ selectedId: 'third' });

    await userEvent.keyboard('{ArrowDown}');

    expect(onSelect).toHaveBeenCalledWith('third');
  });

  it('clamps stepping at the first item', async () => {
    const onSelect = renderLayout();

    await userEvent.keyboard('{ArrowUp}');

    expect(onSelect).toHaveBeenCalledWith('first');
  });

  it('keeps the selection when no items are loaded', async () => {
    const onSelect = renderLayout({ itemIds: [] });

    await userEvent.keyboard('{ArrowDown}');

    expect(onSelect).toHaveBeenCalledWith('first');
  });

  it('steps to the first item when nothing is selected yet', async () => {
    const onSelect = renderLayout({ selectedId: null });

    await userEvent.keyboard('{ArrowDown}');

    expect(onSelect).toHaveBeenCalledWith('first');
  });

  it('clears the selection on Escape', async () => {
    const onSelect = renderLayout();

    await userEvent.keyboard('{Escape}');

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('leaves the keys alone while the detail is closed', async () => {
    const onSelect = renderLayout({ detail: undefined, selectedId: null });

    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Escape}');

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores the keys while the user is typing in a form control', async () => {
    const onSelect = vi.fn();
    render(
      <>
        <input aria-label="filter" />
        <ListDetailLayout
          itemIds={IDS}
          selectedId="first"
          onSelect={onSelect}
          list={<p>the list</p>}
          detail={<p>the detail</p>}
          detailLabel="Row details"
        />
      </>
    );

    await userEvent.click(screen.getByLabelText('filter'));
    await userEvent.keyboard('{ArrowDown}');

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('tags the detail region with a caller-supplied test id', () => {
    renderLayout({ detailTestId: 'row-drawer' });

    expect(screen.getByTestId('row-drawer')).toHaveTextContent('the detail');
  });

  it('applies a custom className to the layout root', () => {
    renderLayout({ className: 'gap-8' });

    expect(document.querySelector('[data-slot="list-detail-layout"]')).toHaveClass('gap-8', 'flex');
  });

  it('has a data-slot attribute', () => {
    renderLayout();

    expect(document.querySelector('[data-slot="list-detail-layout"]')).toBeInTheDocument();
  });
});
