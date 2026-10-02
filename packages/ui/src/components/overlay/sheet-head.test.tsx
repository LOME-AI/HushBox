import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { CLOSE_BUTTON_CLASS } from './overlay-nav-buttons';
import { SheetHead } from './sheet-head';

describe('SheetHead', () => {
  it('shows its title as a heading', () => {
    render(<SheetHead title="Aspect ratio" onClose={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Aspect ratio' })).toBeInTheDocument();
  });

  it('closes from its close button', async () => {
    const onClose = vi.fn();
    render(<SheetHead title="Aspect ratio" onClose={onClose} />);

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('marks its close button as the overlay close', () => {
    render(<SheetHead title="Aspect ratio" onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Close' })).toHaveAttribute(
      'data-slot',
      'overlay-close'
    );
  });

  it('draws its close button as a 1.75rem box at 70% opacity', () => {
    render(<SheetHead title="Aspect ratio" onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('size-7', 'opacity-70');
  });

  it('keeps its close button in the row rather than in the corner', () => {
    render(<SheetHead title="Aspect ratio" onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveClass('absolute');
  });

  it('extends its close button to a 2.75rem target on a coarse pointer', () => {
    render(<SheetHead title="Aspect ratio" onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass(
      'pointer-coarse:before:size-11'
    );
  });

  it("draws its close button as the overlay's close, out of the corner", () => {
    render(<SheetHead title="Aspect ratio" onClose={vi.fn()} />);

    const corner = new Set(['absolute', 'top-5', 'right-3']);
    const drawn = CLOSE_BUTTON_CLASS.split(' ').filter((token) => !corner.has(token));
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass(...drawn);
  });

  it('centres its close button on the title row', () => {
    render(<SheetHead title="Aspect ratio" onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Close' }).parentElement).toHaveClass('items-center');
  });
});
