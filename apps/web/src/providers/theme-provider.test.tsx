import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider, useTheme } from './theme-provider';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => {
      store[key] = value;
    },
    removeItem: (key: string): void => {
      store[key] = undefined as unknown as string;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Required for localStorage mock
      delete store[key];
    },
    clear: (): void => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Test component that uses the theme context
function TestConsumer(): React.JSX.Element {
  const { mode, triggerTransition } = useTheme();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <button
        onClick={(e) => {
          triggerTransition({ x: e.clientX, y: e.clientY });
        }}
        data-testid="toggle"
      >
        Toggle
      </button>
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.remove('dark');
    document.documentElement.style.removeProperty('--transition-x');
    document.documentElement.style.removeProperty('--transition-y');
    document.documentElement.style.removeProperty('--transition-radius');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provides default light mode', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('light');
  });

  it('reads mode from localStorage if available', () => {
    localStorageMock.setItem('themeMode', 'dark');
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
  });

  it('sets data-theme attribute on document', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('provides triggerTransition function', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('toggle')).toBeInTheDocument();
  });

  it('renders children', () => {
    render(
      <ThemeProvider>
        <div data-testid="child">Child content</div>
      </ThemeProvider>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('useTheme throws warning when used outside provider', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

    function InvalidConsumer(): React.JSX.Element {
      const { triggerTransition } = useTheme();
      triggerTransition({ x: 0, y: 0 });
      return <div>test</div>;
    }

    render(<InvalidConsumer />);
    expect(consoleSpy).toHaveBeenCalledWith('ThemeProvider context not available');
    consoleSpy.mockRestore();
  });

  it('toggles theme and updates localStorage when View Transitions API is not supported', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('light');

    // Click toggle button
    fireEvent.click(screen.getByTestId('toggle'));

    // Since View Transitions API is not available in jsdom, it should toggle instantly
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(localStorageMock.getItem('themeMode')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggles back to light mode', () => {
    localStorageMock.setItem('themeMode', 'dark');
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('dark');

    fireEvent.click(screen.getByTestId('toggle'));

    expect(screen.getByTestId('mode')).toHaveTextContent('light');
    expect(localStorageMock.getItem('themeMode')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('sets dark class on documentElement in dark mode', () => {
    localStorageMock.setItem('themeMode', 'dark');
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
