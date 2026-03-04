import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('ThemeToggle', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
    localStorage.clear();
  });

  it('renders with aria-label "Switch to dark mode" in light mode', async () => {
    const { ThemeToggle } = await import('./theme-toggle');
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it('renders with aria-label "Switch to light mode" when dark class is present', async () => {
    document.documentElement.classList.add('dark');
    const { ThemeToggle } = await import('./theme-toggle');
    render(<ThemeToggle />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /switch to light mode/i })).toBeInTheDocument();
    });
  });

  it('toggles dark class on documentElement when clicked with default behavior', async () => {
    const { ThemeToggle } = await import('./theme-toggle');
    const user = userEvent.setup();
    render(<ThemeToggle />);

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    await user.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
  });

  it('persists theme to localStorage themeMode key on default click', async () => {
    const { ThemeToggle } = await import('./theme-toggle');
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(localStorage.getItem('themeMode')).toBe('dark');
    });
  });

  it('calls onToggle instead of default behavior when provided', async () => {
    const { ThemeToggle } = await import('./theme-toggle');
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<ThemeToggle onToggle={onToggle} />);

    await user.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('does NOT toggle dark class when onToggle is provided', async () => {
    const { ThemeToggle } = await import('./theme-toggle');
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<ThemeToggle onToggle={onToggle} />);

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    await user.click(screen.getByRole('button'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('renders the SVG morph icon', async () => {
    const { ThemeToggle } = await import('./theme-toggle');
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-morph-icon')).toBeInTheDocument();
    expect(screen.getByTestId('theme-morph-icon').tagName.toLowerCase()).toBe('svg');
  });

  it('shows sun rays in light mode with scale(1)', async () => {
    const { ThemeToggle } = await import('./theme-toggle');
    render(<ThemeToggle />);
    const rays = screen.getByTestId('sun-rays');
    expect(rays).toBeInTheDocument();
    expect(rays).toHaveStyle({ transform: 'rotate(0deg) scale(1)' });
  });

  it('shows sun body with r=5 in light mode', async () => {
    const { ThemeToggle } = await import('./theme-toggle');
    render(<ThemeToggle />);
    const svg = screen.getByTestId('theme-morph-icon');
    const bodyCircle = svg.querySelector('circle[data-testid="sun-body"]');
    expect(bodyCircle).toBeInTheDocument();
    expect(bodyCircle).toHaveAttribute('r', '5');
  });

  it('positions mask circle off-screen in light mode (cx=28)', async () => {
    const { ThemeToggle } = await import('./theme-toggle');
    render(<ThemeToggle />);
    const svg = screen.getByTestId('theme-morph-icon');
    const maskCircle = svg.querySelector('circle[data-testid="mask-circle"]');
    expect(maskCircle).toBeInTheDocument();
    expect(maskCircle).toHaveAttribute('cx', '28');
  });

  it('shows sun body with r=8 in dark mode', async () => {
    document.documentElement.classList.add('dark');
    const { ThemeToggle } = await import('./theme-toggle');
    render(<ThemeToggle />);
    await waitFor(() => {
      const svg = screen.getByTestId('theme-morph-icon');
      const bodyCircle = svg.querySelector('circle[data-testid="sun-body"]');
      expect(bodyCircle).toHaveAttribute('r', '8');
    });
  });

  it('moves mask circle to create crescent in dark mode (cx=17, cy=7)', async () => {
    document.documentElement.classList.add('dark');
    const { ThemeToggle } = await import('./theme-toggle');
    render(<ThemeToggle />);
    await waitFor(() => {
      const svg = screen.getByTestId('theme-morph-icon');
      const maskCircle = svg.querySelector('circle[data-testid="mask-circle"]');
      expect(maskCircle).toHaveAttribute('cx', '17');
      expect(maskCircle).toHaveAttribute('cy', '7');
    });
  });

  it('hides sun rays in dark mode with scale(0)', async () => {
    document.documentElement.classList.add('dark');
    const { ThemeToggle } = await import('./theme-toggle');
    render(<ThemeToggle />);
    await waitFor(() => {
      const rays = screen.getByTestId('sun-rays');
      expect(rays).toHaveStyle({ transform: 'rotate(45deg) scale(0)' });
    });
  });

  it('uses unique mask ID via useId for multiple instances', async () => {
    const { ThemeToggle } = await import('./theme-toggle');
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

  it('toggles back from dark to light on second click', async () => {
    document.documentElement.classList.add('dark');
    const { ThemeToggle } = await import('./theme-toggle');
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /switch to light mode/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(localStorage.getItem('themeMode')).toBe('light');
    });
  });

  it('uses View Transitions API when available and onToggle not provided', async () => {
    const finishedPromise = Promise.resolve();
    const mockStartViewTransition = vi.fn((callback: () => void) => {
      callback();
      return { finished: finishedPromise };
    });
    const documentRecord = document as unknown as Record<string, unknown>;
    documentRecord['startViewTransition'] = mockStartViewTransition;

    const { ThemeToggle } = await import('./theme-toggle');
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button'));
    expect(mockStartViewTransition).toHaveBeenCalledOnce();

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    // Clean up
    delete documentRecord['startViewTransition'];
  });

  it('does not use View Transitions API when onToggle is provided', async () => {
    const mockStartViewTransition = vi.fn();
    const documentRecord = document as unknown as Record<string, unknown>;
    documentRecord['startViewTransition'] = mockStartViewTransition;

    const { ThemeToggle } = await import('./theme-toggle');
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<ThemeToggle onToggle={onToggle} />);

    await user.click(screen.getByRole('button'));
    expect(mockStartViewTransition).not.toHaveBeenCalled();
    expect(onToggle).toHaveBeenCalledOnce();

    // Clean up
    delete documentRecord['startViewTransition'];
  });

  it('handles localStorage being unavailable gracefully', async () => {
    const { ThemeToggle } = await import('./theme-toggle');
    const user = userEvent.setup();

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage is full');
    });

    render(<ThemeToggle />);

    // Should not throw even though localStorage fails
    await user.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
  });
});
