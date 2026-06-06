import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { ThemeToggle } from './theme-toggle';

const mockTriggerTransition = vi.fn();
vi.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({
    mode: 'light',
    triggerTransition: mockTriggerTransition,
  }),
}));

describe('ThemeToggle wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the base ThemeToggle from @hushbox/ui', () => {
    render(<ThemeToggle />);
    expect(screen.getByTestId(TEST_IDS.themeToggle)).toBeInTheDocument();
  });

  it('renders the SVG morph icon', () => {
    render(<ThemeToggle />);
    expect(screen.getByTestId(TEST_IDS.themeMorphIcon)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.themeMorphIcon).tagName.toLowerCase()).toBe('svg');
  });

  it('calls triggerTransition with click coordinates when clicked', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('button'));
    expect(mockTriggerTransition).toHaveBeenCalledOnce();
    expect(mockTriggerTransition).toHaveBeenCalledWith(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })
    );
  });

  it('does not toggle dark class directly (delegates to provider)', async () => {
    const user = userEvent.setup();
    document.documentElement.classList.remove('dark');
    render(<ThemeToggle />);
    await user.click(screen.getByRole('button'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
