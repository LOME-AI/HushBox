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

describe('ThemeToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders toggle button', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it('has pill shape dimensions (60x30px)', () => {
    render(<ThemeToggle />);
    const button = screen.getByRole('button');
    expect(button).toHaveStyle({ width: '60px', height: '30px' });
  });

  it('has rounded ends (pill shape)', () => {
    render(<ThemeToggle />);
    const button = screen.getByRole('button');
    expect(button).toHaveStyle({ borderRadius: '15px' });
  });

  it('renders light-mode icon for light mode', () => {
    render(<ThemeToggle />);
    expect(screen.getByTestId('light-mode-icon')).toBeInTheDocument();
  });

  it('light-mode icon is a filled sun with rays', () => {
    render(<ThemeToggle />);
    const icon = screen.getByTestId('light-mode-icon');
    // Should be an SVG element
    expect(icon.tagName.toLowerCase()).toBe('svg');
    // Should contain a circle (sun center) and lines/paths (rays)
    expect(icon.querySelector('circle')).toBeInTheDocument();
  });

  it('calls triggerTransition with click coordinates when clicked', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button'));
    expect(mockTriggerTransition).toHaveBeenCalled();
  });

  it('renders sliding thumb element', () => {
    render(<ThemeToggle />);
    expect(screen.getByTestId('thumb')).toBeInTheDocument();
  });
});

describe('ThemeToggle dark mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has correct aria-label for dark mode', async () => {
    // Re-import to get updated mock
    vi.resetModules();
    vi.doMock('@/providers/theme-provider', () => ({
      useTheme: () => ({
        mode: 'dark',
        triggerTransition: mockTriggerTransition,
      }),
    }));
    const { ThemeToggle: ThemeToggleDark } = await import('./theme-toggle');
    render(<ThemeToggleDark />);
    expect(screen.getByRole('button', { name: /switch to light mode/i })).toBeInTheDocument();
  });

  it('renders dark-mode icon for dark mode', async () => {
    vi.resetModules();
    vi.doMock('@/providers/theme-provider', () => ({
      useTheme: () => ({
        mode: 'dark',
        triggerTransition: mockTriggerTransition,
      }),
    }));
    const { ThemeToggle: ThemeToggleDark } = await import('./theme-toggle');
    render(<ThemeToggleDark />);
    expect(screen.getByTestId('dark-mode-icon')).toBeInTheDocument();
  });

  it('dark-mode icon is a crescent moon shape', async () => {
    vi.resetModules();
    vi.doMock('@/providers/theme-provider', () => ({
      useTheme: () => ({
        mode: 'dark',
        triggerTransition: mockTriggerTransition,
      }),
    }));
    const { ThemeToggle: ThemeToggleDark } = await import('./theme-toggle');
    render(<ThemeToggleDark />);
    const icon = screen.getByTestId('dark-mode-icon');
    // Should be an SVG element
    expect(icon.tagName.toLowerCase()).toBe('svg');
    // Should contain a path for the crescent shape
    expect(icon.querySelector('path')).toBeInTheDocument();
  });
});
