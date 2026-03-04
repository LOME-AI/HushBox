import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeToggle } from './theme-toggle';

// Mock the theme provider
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
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('renders the SVG morph icon', () => {
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-morph-icon')).toBeInTheDocument();
    expect(screen.getByTestId('theme-morph-icon').tagName.toLowerCase()).toBe('svg');
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
    // The wrapper uses onToggle, so default toggle behavior is skipped
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
