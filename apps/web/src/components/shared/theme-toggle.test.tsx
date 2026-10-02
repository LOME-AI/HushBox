import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { triggerViewTransition } from '@hushbox/ui';
import { renderWithProviders } from '@/test-utils/render';
import { ThemeToggle } from './theme-toggle';

// The provider reaches the DOM only through `triggerViewTransition`, so holding
// that call is the only seam that separates what this wrapper does to the
// document from what the provider does on its behalf.
vi.mock('@hushbox/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hushbox/ui')>()),
  triggerViewTransition: vi.fn(),
}));

const viewTransition = vi.mocked(triggerViewTransition);

describe('ThemeToggle wrapper', () => {
  beforeEach(() => {
    viewTransition.mockReset();
    viewTransition.mockImplementation((_origin, applyChange) => {
      applyChange();
    });
    delete document.documentElement.dataset['theme'];
    document.documentElement.classList.remove('dark');
  });

  it('renders the base ThemeToggle from @hushbox/ui', () => {
    renderWithProviders(<ThemeToggle />);
    expect(screen.getByTestId(TEST_IDS.themeToggle)).toBeInTheDocument();
  });

  it('renders the SVG morph icon', () => {
    renderWithProviders(<ThemeToggle />);
    expect(screen.getByTestId(TEST_IDS.themeMorphIcon)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.themeMorphIcon).tagName.toLowerCase()).toBe('svg');
  });

  it('passes the click coordinates through to the transition', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ThemeToggle />);

    await user.click(screen.getByTestId(TEST_IDS.themeToggle));

    expect(viewTransition).toHaveBeenCalledOnce();
    expect(viewTransition).toHaveBeenCalledWith(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
      expect.any(Function)
    );
  });

  it('does not toggle dark class directly (delegates to provider)', async () => {
    const user = userEvent.setup();
    viewTransition.mockImplementation(() => {
      /* the provider's change never applies, so any class flip is the wrapper's */
    });
    renderWithProviders(<ThemeToggle />);

    await user.click(screen.getByTestId(TEST_IDS.themeToggle));

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('delegates the click to the provider, which applies the new mode', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ThemeToggle />);

    await user.click(screen.getByTestId(TEST_IDS.themeToggle));

    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
