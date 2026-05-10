import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { useOsPreferences } from './use-os-preferences';

interface MockMediaQueryList {
  readonly matches: boolean;
  media: string;
  onchange: null;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
}

describe('useOsPreferences', () => {
  const originalMatchMedia = globalThis.matchMedia;
  let mockMatchMedia: ReturnType<typeof vi.fn>;
  let mediaQueryListeners: Map<string, Set<(e: MediaQueryListEvent) => void>>;
  let activeMatches: Set<string>;

  /**
   * Creates a mock matchMedia where each query's match state is read live
   * from a shared `activeMatches` set. This mirrors browsers, where
   * matchMedia() always returns the current match state on each call.
   * @param initiallyMatched - Set of query strings that should match initially.
   */
  const createMockMatchMedia = (initiallyMatched: Set<string>): void => {
    mediaQueryListeners = new Map();
    activeMatches = new Set(initiallyMatched);
    mockMatchMedia = vi.fn().mockImplementation((query: string): MockMediaQueryList => {
      return {
        get matches(): boolean {
          return activeMatches.has(query);
        },
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((event: string, callback: (e: MediaQueryListEvent) => void) => {
          if (event === 'change') {
            const set = mediaQueryListeners.get(query) ?? new Set();
            set.add(callback);
            mediaQueryListeners.set(query, set);
          }
        }),
        removeEventListener: vi.fn((event: string, callback: (e: MediaQueryListEvent) => void) => {
          if (event === 'change') {
            mediaQueryListeners.get(query)?.delete(callback);
          }
        }),
        dispatchEvent: vi.fn(),
      } as MockMediaQueryList;
    });
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      configurable: true,
      value: mockMatchMedia,
    });
  };

  /** Updates the simulated match state and notifies listeners. */
  const fireChange = (query: string, matches: boolean): void => {
    if (matches) activeMatches.add(query);
    else activeMatches.delete(query);
    const listeners = mediaQueryListeners.get(query);
    if (listeners) {
      for (const listener of listeners) {
        listener({ matches } as MediaQueryListEvent);
      }
    }
  };

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  it('returns sensible defaults when no media queries match', () => {
    createMockMatchMedia(new Set());
    const { result } = renderHook(() => useOsPreferences());

    expect(result.current).toEqual({
      reducedMotion: false,
      colorScheme: null,
      contrast: 'normal',
    });
  });

  it('reports reducedMotion = true when prefers-reduced-motion: reduce matches', () => {
    createMockMatchMedia(new Set(['(prefers-reduced-motion: reduce)']));
    const { result } = renderHook(() => useOsPreferences());

    expect(result.current.reducedMotion).toBe(true);
  });

  it('reports colorScheme = "dark" when prefers-color-scheme: dark matches', () => {
    createMockMatchMedia(new Set(['(prefers-color-scheme: dark)']));
    const { result } = renderHook(() => useOsPreferences());

    expect(result.current.colorScheme).toBe('dark');
  });

  it('reports colorScheme = "light" when prefers-color-scheme: light matches', () => {
    createMockMatchMedia(new Set(['(prefers-color-scheme: light)']));
    const { result } = renderHook(() => useOsPreferences());

    expect(result.current.colorScheme).toBe('light');
  });

  it('reports colorScheme = null when neither dark nor light matches', () => {
    createMockMatchMedia(new Set());
    const { result } = renderHook(() => useOsPreferences());

    expect(result.current.colorScheme).toBeNull();
  });

  it('prefers "dark" over "light" when both queries somehow match', () => {
    createMockMatchMedia(
      new Set(['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)'])
    );
    const { result } = renderHook(() => useOsPreferences());

    expect(result.current.colorScheme).toBe('dark');
  });

  it('reports contrast = "more" when prefers-contrast: more matches', () => {
    createMockMatchMedia(new Set(['(prefers-contrast: more)']));
    const { result } = renderHook(() => useOsPreferences());

    expect(result.current.contrast).toBe('more');
  });

  it('reports contrast = "less" when prefers-contrast: less matches', () => {
    createMockMatchMedia(new Set(['(prefers-contrast: less)']));
    const { result } = renderHook(() => useOsPreferences());

    expect(result.current.contrast).toBe('less');
  });

  it('reports contrast = "normal" when no contrast preference matches', () => {
    createMockMatchMedia(new Set());
    const { result } = renderHook(() => useOsPreferences());

    expect(result.current.contrast).toBe('normal');
  });

  it('updates state when prefers-reduced-motion changes', () => {
    createMockMatchMedia(new Set());
    const { result } = renderHook(() => useOsPreferences());

    expect(result.current.reducedMotion).toBe(false);

    act(() => {
      fireChange('(prefers-reduced-motion: reduce)', true);
    });

    expect(result.current.reducedMotion).toBe(true);
  });

  it('updates state when prefers-color-scheme changes from dark to light', () => {
    createMockMatchMedia(new Set(['(prefers-color-scheme: dark)']));
    const { result } = renderHook(() => useOsPreferences());

    expect(result.current.colorScheme).toBe('dark');

    act(() => {
      fireChange('(prefers-color-scheme: dark)', false);
      fireChange('(prefers-color-scheme: light)', true);
    });

    expect(result.current.colorScheme).toBe('light');
  });

  it('updates state when prefers-contrast changes from normal to more', () => {
    createMockMatchMedia(new Set());
    const { result } = renderHook(() => useOsPreferences());

    expect(result.current.contrast).toBe('normal');

    act(() => {
      fireChange('(prefers-contrast: more)', true);
    });

    expect(result.current.contrast).toBe('more');
  });

  it('subscribes to change events for every tracked media query', () => {
    createMockMatchMedia(new Set());
    renderHook(() => useOsPreferences());

    const trackedQueries = [
      '(prefers-reduced-motion: reduce)',
      '(prefers-color-scheme: dark)',
      '(prefers-color-scheme: light)',
      '(prefers-contrast: more)',
      '(prefers-contrast: less)',
    ];
    for (const query of trackedQueries) {
      expect(mediaQueryListeners.get(query)?.size ?? 0).toBeGreaterThan(0);
    }
  });

  it('removes change listeners on unmount', () => {
    createMockMatchMedia(new Set());
    const { unmount } = renderHook(() => useOsPreferences());

    const trackedQueries = [
      '(prefers-reduced-motion: reduce)',
      '(prefers-color-scheme: dark)',
      '(prefers-color-scheme: light)',
      '(prefers-contrast: more)',
      '(prefers-contrast: less)',
    ];

    for (const query of trackedQueries) {
      expect(mediaQueryListeners.get(query)?.size ?? 0).toBeGreaterThan(0);
    }

    unmount();

    for (const query of trackedQueries) {
      expect(mediaQueryListeners.get(query)?.size ?? 0).toBe(0);
    }
  });

  it('returns SSR-safe defaults when matchMedia is unavailable', () => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      configurable: true,
      value: undefined,
    });

    const { result, unmount } = renderHook(() => useOsPreferences());

    expect(result.current).toEqual({
      reducedMotion: false,
      colorScheme: null,
      contrast: null,
    });

    // Cleanup must not throw when matchMedia is unavailable.
    expect(() => {
      unmount();
    }).not.toThrow();
  });
});
