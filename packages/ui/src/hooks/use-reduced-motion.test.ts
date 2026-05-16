import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { useA11yStore } from '../components/accessibility/store';
import { shouldReduceMotion, subscribeReducedMotion, useReducedMotion } from './use-reduced-motion';

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

  beforeEach(() => {
    useA11yStore.getState().reset();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    useA11yStore.getState().reset();
    vi.restoreAllMocks();
  });

  describe('media-query input', () => {
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
      const mediaQueryList = lastResult?.value as {
        removeEventListener: ReturnType<typeof vi.fn>;
      };
      unmount();

      expect(mediaQueryList.removeEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function)
      );
    });
  });

  describe('a11y-store input', () => {
    it('returns true when only the a11y-store stopAnimations flag is on', () => {
      createMockMatchMedia(false);
      useA11yStore.getState().update({ stopAnimations: true });

      const { result } = renderHook(() => useReducedMotion());

      expect(result.current).toBe(true);
    });

    it('re-renders when stopAnimations toggles on mid-session', () => {
      createMockMatchMedia(false);
      const { result } = renderHook(() => useReducedMotion());

      expect(result.current).toBe(false);

      act(() => {
        useA11yStore.getState().update({ stopAnimations: true });
      });

      expect(result.current).toBe(true);
    });

    it('re-renders when stopAnimations toggles off mid-session', () => {
      createMockMatchMedia(false);
      useA11yStore.getState().update({ stopAnimations: true });
      const { result } = renderHook(() => useReducedMotion());

      expect(result.current).toBe(true);

      act(() => {
        useA11yStore.getState().update({ stopAnimations: false });
      });

      expect(result.current).toBe(false);
    });
  });

  describe('merged inputs', () => {
    it('returns true when media-query matches even if store flag is off', () => {
      createMockMatchMedia(true);
      useA11yStore.getState().update({ stopAnimations: false });

      const { result } = renderHook(() => useReducedMotion());

      expect(result.current).toBe(true);
    });

    it('returns true when both inputs are on', () => {
      createMockMatchMedia(true);
      useA11yStore.getState().update({ stopAnimations: true });

      const { result } = renderHook(() => useReducedMotion());

      expect(result.current).toBe(true);
    });

    it('returns false only when both inputs are off', () => {
      createMockMatchMedia(false);
      useA11yStore.getState().update({ stopAnimations: false });

      const { result } = renderHook(() => useReducedMotion());

      expect(result.current).toBe(false);
    });

    it('stays true when media-query turns off but store flag is still on', () => {
      createMockMatchMedia(true);
      useA11yStore.getState().update({ stopAnimations: true });
      const { result } = renderHook(() => useReducedMotion());

      expect(result.current).toBe(true);

      act(() => {
        const listener = mediaQueryListeners.get('(prefers-reduced-motion: reduce)');
        listener?.({ matches: false } as MediaQueryListEvent);
      });

      expect(result.current).toBe(true);
    });
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

describe('shouldReduceMotion', () => {
  const originalMatchMedia = globalThis.matchMedia;

  const stubMatchMedia = (matches: boolean): void => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  };

  beforeEach(() => {
    useA11yStore.getState().reset();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    useA11yStore.getState().reset();
  });

  it('returns false when neither input is on', () => {
    stubMatchMedia(false);
    expect(shouldReduceMotion()).toBe(false);
  });

  it('returns true when only media-query matches', () => {
    stubMatchMedia(true);
    expect(shouldReduceMotion()).toBe(true);
  });

  it('returns true when only the store flag is on', () => {
    stubMatchMedia(false);
    useA11yStore.getState().update({ stopAnimations: true });
    expect(shouldReduceMotion()).toBe(true);
  });

  it('returns true when both are on', () => {
    stubMatchMedia(true);
    useA11yStore.getState().update({ stopAnimations: true });
    expect(shouldReduceMotion()).toBe(true);
  });
});

describe('subscribeReducedMotion', () => {
  const originalMatchMedia = globalThis.matchMedia;
  let mediaListeners: Set<(e: MediaQueryListEvent) => void>;

  const installMatchMedia = (initialMatches: boolean): { setMatches: (m: boolean) => void } => {
    mediaListeners = new Set();
    let currentMatches = initialMatches;
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return currentMatches;
        },
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((event: string, callback: (e: MediaQueryListEvent) => void) => {
          if (event === 'change') mediaListeners.add(callback);
        }),
        removeEventListener: vi.fn((event: string, callback: (e: MediaQueryListEvent) => void) => {
          if (event === 'change') mediaListeners.delete(callback);
        }),
        dispatchEvent: vi.fn(),
      })),
    });
    return {
      setMatches: (next: boolean) => {
        currentMatches = next;
        for (const callback of mediaListeners) callback({ matches: next } as MediaQueryListEvent);
      },
    };
  };

  beforeEach(() => {
    useA11yStore.getState().reset();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    useA11yStore.getState().reset();
  });

  it('fires the listener when the media query changes', () => {
    const mq = installMatchMedia(false);
    const listener = vi.fn();
    const unsubscribe = subscribeReducedMotion(listener);

    mq.setMatches(true);

    expect(listener).toHaveBeenCalledWith(true);
    unsubscribe();
  });

  it('fires the listener when the store flag changes', () => {
    installMatchMedia(false);
    const listener = vi.fn();
    const unsubscribe = subscribeReducedMotion(listener);

    useA11yStore.getState().update({ stopAnimations: true });

    expect(listener).toHaveBeenCalledWith(true);
    unsubscribe();
  });

  it('does not re-fire when the merged value did not change', () => {
    installMatchMedia(true);
    const listener = vi.fn();
    const unsubscribe = subscribeReducedMotion(listener);

    // Already true (media). Flipping store on keeps merged value true → no fire.
    useA11yStore.getState().update({ stopAnimations: true });
    // Flipping store off still leaves merged true (media still matches).
    useA11yStore.getState().update({ stopAnimations: false });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('detaches both subscriptions on unsubscribe', () => {
    const mq = installMatchMedia(false);
    const listener = vi.fn();
    const unsubscribe = subscribeReducedMotion(listener);
    unsubscribe();

    mq.setMatches(true);
    useA11yStore.getState().update({ stopAnimations: true });

    expect(listener).not.toHaveBeenCalled();
  });
});
