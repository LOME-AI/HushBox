import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// AccessibilityPanel pulls in the entire section tree (kokoro-js, readability,
// font loader, etc.). The widget only needs to know the panel mounts inside the
// sheet — replace it with a simple sentinel.
vi.mock('./accessibility-panel', () => ({
  AccessibilityPanel: (): React.JSX.Element => (
    <div data-testid="mock-accessibility-panel">Accessibility panel</div>
  ),
}));

import { AccessibilityWidget } from './accessibility-widget';

describe('AccessibilityWidget', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('trigger button', () => {
    it('renders a button with the accessibility aria-label', () => {
      render(<AccessibilityWidget />);
      const trigger = screen.getByRole('button', { name: /accessibility settings/i });
      expect(trigger).toBeInTheDocument();
    });

    it('positions the trigger button fixed in the bottom-left', () => {
      render(<AccessibilityWidget />);
      const trigger = screen.getByRole('button', { name: /accessibility settings/i });
      expect(trigger).toHaveClass('fixed');
      expect(trigger).toHaveClass('bottom-4');
      expect(trigger).toHaveClass('left-4');
    });

    it('uses the brand-red token for the trigger background', () => {
      render(<AccessibilityWidget />);
      const trigger = screen.getByRole('button', { name: /accessibility settings/i });
      expect(trigger).toHaveClass('bg-brand-red');
    });

    it('renders a circular trigger button with z-50 stacking', () => {
      render(<AccessibilityWidget />);
      const trigger = screen.getByRole('button', { name: /accessibility settings/i });
      expect(trigger).toHaveClass('rounded-full');
      expect(trigger).toHaveClass('z-50');
    });

    it('hides the lucide icon from the accessibility tree', () => {
      render(<AccessibilityWidget />);
      const trigger = screen.getByRole('button', { name: /accessibility settings/i });
      const svg = trigger.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    });
  });

  describe('panel toggle', () => {
    it('does not render the AccessibilityPanel by default', () => {
      render(<AccessibilityWidget />);
      expect(screen.queryByTestId('mock-accessibility-panel')).toBeNull();
    });

    it('opens the sheet and reveals the AccessibilityPanel when the trigger is clicked', async () => {
      const user = userEvent.setup();
      render(<AccessibilityWidget />);
      await user.click(screen.getByRole('button', { name: /accessibility settings/i }));
      await waitFor(() => {
        expect(screen.getByTestId('mock-accessibility-panel')).toBeInTheDocument();
      });
    });

    it('renders the SidebarPanelHeader title "Accessibility" when open', async () => {
      const user = userEvent.setup();
      render(<AccessibilityWidget />);
      await user.click(screen.getByRole('button', { name: /accessibility settings/i }));
      await waitFor(() => {
        expect(screen.getByText('Accessibility')).toBeInTheDocument();
      });
    });

    it('closes the sheet when the SidebarPanelHeader X button is clicked', async () => {
      const user = userEvent.setup();
      render(<AccessibilityWidget />);
      await user.click(screen.getByRole('button', { name: /accessibility settings/i }));
      await waitFor(() => {
        expect(screen.getByTestId('mock-accessibility-panel')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /close sidebar/i }));
      await waitFor(() => {
        expect(screen.queryByTestId('mock-accessibility-panel')).toBeNull();
      });
    });

    it('closes the sheet when Escape is pressed', async () => {
      const user = userEvent.setup();
      render(<AccessibilityWidget />);
      await user.click(screen.getByRole('button', { name: /accessibility settings/i }));
      await waitFor(() => {
        expect(screen.getByTestId('mock-accessibility-panel')).toBeInTheDocument();
      });

      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByTestId('mock-accessibility-panel')).toBeNull();
      });
    });

    it('only renders one close button (no duplicate from SheetContent)', async () => {
      const user = userEvent.setup();
      render(<AccessibilityWidget />);
      await user.click(screen.getByRole('button', { name: /accessibility settings/i }));
      await waitFor(() => {
        expect(screen.getByTestId('mock-accessibility-panel')).toBeInTheDocument();
      });

      const closeButtons = screen.getAllByRole('button', { name: /close/i });
      expect(closeButtons).toHaveLength(1);
      expect(closeButtons[0]).toHaveAttribute('aria-label', 'Close sidebar');
    });

    it('exposes a screen-reader-only Sheet title (Radix dialog requirement)', async () => {
      const user = userEvent.setup();
      render(<AccessibilityWidget />);
      await user.click(screen.getByRole('button', { name: /accessibility settings/i }));
      await waitFor(() => {
        expect(screen.getByTestId('mock-accessibility-panel')).toBeInTheDocument();
      });

      const dialog = screen.getByRole('dialog');
      // Radix wires aria-labelledby to a SheetTitle (DialogTitle); presence of
      // the attribute proves we satisfied the dialog labelling contract.
      expect(dialog).toHaveAttribute('aria-labelledby');
      expect(dialog).toHaveAttribute('aria-describedby');
    });
  });
});
