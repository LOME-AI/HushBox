import * as React from 'react';
import { useA11yStore } from '../components/accessibility/store';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function noop(): void {
  /* SSR fallback for subscribeReducedMotion when window is absent. */
}

/**
 * Reduced-motion is a derived signal from three independent inputs OR'd together:
 *   1. The OS `prefers-reduced-motion: reduce` media query (set in system settings).
 *   2. The in-app accessibility widget's `stopAnimations` toggle.
 *   3. The store's `forcedReducedMotion` override, which each host app sets once
 *      at boot from its own `envUtils`. E2E builds force it on because
 *      Playwright's reduced-motion media emulation does not reliably propagate
 *      to WebKit. It rides the store rather than a build flag because a
 *      component library must not read the host's environment, and because the
 *      store is the only state the synchronous entry point below can reach —
 *      the init script and the class broadcaster are outside React, so a
 *      context provider could not carry it.
 *
 * Any source alone is enough to put the app into reduced-motion mode. All three
 * broadcasters (CSS class on `<html>`, Framer Motion's MotionConfig, and this
 * hook) derive from this single merged value so they cannot drift.
 */

/** Synchronous read for non-React callers (init script, class broadcaster). SSR-safe — returns false when window is absent. */
export function shouldReduceMotion(): boolean {
  if (!('window' in globalThis)) return false;
  const { stopAnimations, forcedReducedMotion } = useA11yStore.getState();
  if (forcedReducedMotion) return true;
  const mediaPref =
    'matchMedia' in globalThis ? globalThis.matchMedia(REDUCED_MOTION_QUERY).matches : false;
  return mediaPref || stopAnimations;
}

/**
 * Subscribe to merged reduced-motion changes. Fires the listener only when the
 * derived value flips, not on every input change — i.e. flipping the widget
 * while the media query already matches is a no-op for subscribers.
 */
export function subscribeReducedMotion(listener: (value: boolean) => void): () => void {
  if (!('window' in globalThis)) return noop;

  let previous = shouldReduceMotion();
  const onChange = (): void => {
    const next = shouldReduceMotion();
    if (next !== previous) {
      previous = next;
      listener(next);
    }
  };

  const mediaQuery =
    'matchMedia' in globalThis ? globalThis.matchMedia(REDUCED_MOTION_QUERY) : null;
  mediaQuery?.addEventListener('change', onChange);
  const unsubscribeStore = useA11yStore.subscribe(onChange);

  return () => {
    mediaQuery?.removeEventListener('change', onChange);
    unsubscribeStore();
  };
}

/**
 * React hook returning the merged reduced-motion value. Re-renders whenever
 * either source changes — the OS media query (via MediaQueryList change event)
 * or the a11y store's `stopAnimations` (via the zustand subscription).
 */
export function useReducedMotion(): boolean {
  const stopAnimations = useA11yStore((s) => s.stopAnimations);
  const forcedReducedMotion = useA11yStore((s) => s.forcedReducedMotion);
  const [mediaPref, setMediaPref] = React.useState<boolean>(() => {
    if (!('window' in globalThis)) return false;
    return globalThis.matchMedia(REDUCED_MOTION_QUERY).matches;
  });

  React.useEffect(() => {
    if (!('window' in globalThis)) return;
    const mediaQuery = globalThis.matchMedia(REDUCED_MOTION_QUERY);
    const handler = (e: MediaQueryListEvent): void => {
      setMediaPref(e.matches);
    };
    setMediaPref(mediaQuery.matches);
    mediaQuery.addEventListener('change', handler);
    return () => {
      mediaQuery.removeEventListener('change', handler);
    };
  }, []);

  return forcedReducedMotion || mediaPref || stopAnimations;
}
