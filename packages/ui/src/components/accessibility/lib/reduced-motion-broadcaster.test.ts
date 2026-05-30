import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useA11yStore } from '../store';
import { installReducedMotionClass } from './reduced-motion-broadcaster';

describe('installReducedMotionClass', () => {
  const originalMatchMedia = globalThis.matchMedia;
  let mediaListeners: Set<(e: MediaQueryListEvent) => void>;

  function installMatchMedia(initialMatches: boolean): {
    setMatches: (next: boolean) => void;
  } {
    mediaListeners = new Set();
    let currentMatches = initialMatches;
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      configurable: true,
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
  }

  beforeEach(() => {
    useA11yStore.getState().reset();
    document.documentElement.classList.remove('reduced-motion');
    vi.stubEnv('VITE_E2E', '');
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
    useA11yStore.getState().reset();
    document.documentElement.classList.remove('reduced-motion');
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not add reduced-motion class when both sources are off', () => {
    installMatchMedia(false);
    const cleanup = installReducedMotionClass();

    expect(document.documentElement.classList.contains('reduced-motion')).toBe(false);
    cleanup();
  });

  it('adds reduced-motion class synchronously when the OS pref is on', () => {
    installMatchMedia(true);
    const cleanup = installReducedMotionClass();

    expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);
    cleanup();
  });

  it('adds reduced-motion class synchronously when the a11y store flag is on', () => {
    installMatchMedia(false);
    useA11yStore.getState().update({ stopAnimations: true });

    const cleanup = installReducedMotionClass();

    expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);
    cleanup();
  });

  it('toggles the class when the media query changes', () => {
    const mq = installMatchMedia(false);
    const cleanup = installReducedMotionClass();

    expect(document.documentElement.classList.contains('reduced-motion')).toBe(false);

    mq.setMatches(true);
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);

    mq.setMatches(false);
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(false);

    cleanup();
  });

  it('toggles the class when the a11y store flag changes', () => {
    installMatchMedia(false);
    const cleanup = installReducedMotionClass();

    useA11yStore.getState().update({ stopAnimations: true });
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);

    useA11yStore.getState().update({ stopAnimations: false });
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(false);

    cleanup();
  });

  it('keeps the class when one source turns off while the other is still on', () => {
    const mq = installMatchMedia(true);
    useA11yStore.getState().update({ stopAnimations: true });
    const cleanup = installReducedMotionClass();

    mq.setMatches(false);
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(true);

    useA11yStore.getState().update({ stopAnimations: false });
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(false);

    cleanup();
  });

  it('stops reacting after cleanup', () => {
    const mq = installMatchMedia(false);
    const cleanup = installReducedMotionClass();
    cleanup();

    mq.setMatches(true);
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(false);

    useA11yStore.getState().update({ stopAnimations: true });
    expect(document.documentElement.classList.contains('reduced-motion')).toBe(false);
  });
});
