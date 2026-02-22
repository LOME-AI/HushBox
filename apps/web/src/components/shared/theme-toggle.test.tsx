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

  it('renders button with aria-label indicating switch action', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it('renders morph icon SVG', () => {
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-morph-icon')).toBeInTheDocument();
    expect(screen.getByTestId('theme-morph-icon').tagName.toLowerCase()).toBe('svg');
  });

  it('shows sun rays in light mode', () => {
    render(<ThemeToggle />);
    const rays = screen.getByTestId('sun-rays');
    expect(rays).toBeInTheDocument();
    expect(rays).toHaveStyle({ transform: 'rotate(0deg) scale(1)' });
  });

  it('renders sun body circle with mask', () => {
    render(<ThemeToggle />);
    const svg = screen.getByTestId('theme-morph-icon');
    const bodyCircle = svg.querySelector('circle[data-testid="sun-body"]');
    expect(bodyCircle).toBeInTheDocument();
    expect(bodyCircle).toHaveAttribute('r', '5');
  });

  it('positions mask circle off-screen in light mode', () => {
    render(<ThemeToggle />);
    const svg = screen.getByTestId('theme-morph-icon');
    const maskCircle = svg.querySelector('circle[data-testid="mask-circle"]');
    expect(maskCircle).toBeInTheDocument();
    expect(maskCircle).toHaveAttribute('cx', '28');
  });

  it('calls triggerTransition when clicked', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    await user.click(screen.getByRole('button'));
    expect(mockTriggerTransition).toHaveBeenCalled();
  });

  it('uses unique mask ID via useId', () => {
    const { container } = render(
      <div>
        <ThemeToggle />
        <ThemeToggle />
      </div>
    );
    const masks = container.querySelectorAll('mask');
    expect(masks).toHaveLength(2);
    const id1 = masks[0]!.getAttribute('id');
    const id2 = masks[1]!.getAttribute('id');
    expect(id1).not.toBe(id2);
  });
});

describe('ThemeToggle dark mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has correct aria-label for dark mode', async () => {
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

  it('expands sun body to moon size in dark mode', async () => {
    vi.resetModules();
    vi.doMock('@/providers/theme-provider', () => ({
      useTheme: () => ({
        mode: 'dark',
        triggerTransition: mockTriggerTransition,
      }),
    }));
    const { ThemeToggle: ThemeToggleDark } = await import('./theme-toggle');
    render(<ThemeToggleDark />);
    const svg = screen.getByTestId('theme-morph-icon');
    const bodyCircle = svg.querySelector('circle[data-testid="sun-body"]');
    expect(bodyCircle).toHaveAttribute('r', '8');
  });

  it('moves mask circle to create crescent in dark mode', async () => {
    vi.resetModules();
    vi.doMock('@/providers/theme-provider', () => ({
      useTheme: () => ({
        mode: 'dark',
        triggerTransition: mockTriggerTransition,
      }),
    }));
    const { ThemeToggle: ThemeToggleDark } = await import('./theme-toggle');
    render(<ThemeToggleDark />);
    const svg = screen.getByTestId('theme-morph-icon');
    const maskCircle = svg.querySelector('circle[data-testid="mask-circle"]');
    expect(maskCircle).toHaveAttribute('cx', '17');
    expect(maskCircle).toHaveAttribute('cy', '7');
  });

  it('hides sun rays in dark mode', async () => {
    vi.resetModules();
    vi.doMock('@/providers/theme-provider', () => ({
      useTheme: () => ({
        mode: 'dark',
        triggerTransition: mockTriggerTransition,
      }),
    }));
    const { ThemeToggle: ThemeToggleDark } = await import('./theme-toggle');
    render(<ThemeToggleDark />);
    const rays = screen.getByTestId('sun-rays');
    expect(rays).toHaveStyle({ transform: 'rotate(45deg) scale(0)' });
  });
});
