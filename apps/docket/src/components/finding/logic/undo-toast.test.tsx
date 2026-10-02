import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Toaster } from '@hushbox/ui';
import { UNDO_TOAST_MS, showUndoToast } from './undo-toast';

describe('showUndoToast', () => {
  it('stays on screen for at least the six seconds a misclick needs', () => {
    expect(UNDO_TOAST_MS).toBeGreaterThanOrEqual(6000);
  });

  it('announces what was written', async () => {
    render(<Toaster />);

    showUndoToast('Ruled AI-1 as A', () => {});

    await waitFor(() => {
      expect(screen.getByText('Ruled AI-1 as A')).toBeInTheDocument();
    });
  });

  it('offers an undo the reader can take back', async () => {
    const onUndo = vi.fn();
    render(<Toaster />);

    showUndoToast('Denied AI-1', onUndo);

    const button = await screen.findByRole('button', { name: 'Undo' });
    fireEvent.click(button);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
