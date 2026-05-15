import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { useReducedMotion } from './use-reduced-motion';

describe('useReducedMotion', () => {
  const originalMatchMedia = globalThis.matchMedia;
  let mockMatchMedia: ReturnType<typeof vi.fn>;
  let mediaQueryListeners: Map<string, (e: MediaQueryListEvent) => void>;

  const createMockMatchMedia = (matches: boolean): void => {
    mediaQueryListeners = new Map();
    mockMatchMedia = vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((event: string, callback: (e: MediaQueryListEvent) => void) => {
        if (event === 'change') {
          mediaQueryListeners.set(query, callback);
        }
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: mockMatchMedia,
    });
  };

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  it('returns false by default when prefers-reduced-motion is not set', () => {
    createMockMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());

    expect(result.current).toBe(false);
  });

  it('returns true when prefers-reduced-motion: reduce matches', () => {
    createMockMatchMedia(true);
    const { result } = renderHook(() => useReducedMotion());

    expect(result.current).toBe(true);
  });

  it('uses the correct media query (prefers-reduced-motion: reduce)', () => {
    createMockMatchMedia(false);
    renderHook(() => useReducedMotion());

    expect(mockMatchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('updates when MediaQueryList emits change with matches=true', () => {
    createMockMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());

    expect(result.current).toBe(false);

    act(() => {
      const listener = mediaQueryListeners.get('(prefers-reduced-motion: reduce)');
      listener?.({ matches: true } as MediaQueryListEvent);
    });

    expect(result.current).toBe(true);
  });

  it('updates when MediaQueryList emits change with matches=false', () => {
    createMockMatchMedia(true);
    const { result } = renderHook(() => useReducedMotion());

    expect(result.current).toBe(true);

    act(() => {
      const listener = mediaQueryListeners.get('(prefers-reduced-motion: reduce)');
      listener?.({ matches: false } as MediaQueryListEvent);
    });

    expect(result.current).toBe(false);
  });

  it('removes event listener on unmount', () => {
    createMockMatchMedia(false);
    const { unmount } = renderHook(() => useReducedMotion());

    const lastCallIndex = mockMatchMedia.mock.results.length - 1;
    const lastResult = mockMatchMedia.mock.results[lastCallIndex];
    const mediaQueryList = lastResult?.value as { removeEventListener: ReturnType<typeof vi.fn> };
    unmount();

    expect(mediaQueryList.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('does not call matchMedia at module import (SSR-safe)', async () => {
    const matchMediaSpy = vi.fn(() => {
      throw new Error('matchMedia must not be called at module load');
    });
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: matchMediaSpy,
    });

    vi.resetModules();
    await import('./use-reduced-motion');

    expect(matchMediaSpy).not.toHaveBeenCalled();
  });
});
