import { shouldReduceMotion } from '../hooks/use-reduced-motion';

/**
 * Trigger a View Transitions API circular-reveal animation from a click origin.
 * Falls back to calling applyChange() directly if the API is not supported, or if
 * the merged reduced-motion signal is set. The guard has to live here rather than
 * at the call sites: the reveal runs on the `::view-transition-*` pseudo tree,
 * which hangs off the document element and so is matched by none of the blanket
 * `html.reduced-motion *` suppression selectors.
 */
export function triggerViewTransition(
  origin: { x: number; y: number },
  applyChange: () => void
): void {
  if (
    typeof document === 'undefined' ||
    !('startViewTransition' in document) ||
    shouldReduceMotion()
  ) {
    applyChange();
    return;
  }

  const maxRadius =
    Math.max(
      Math.hypot(origin.x, origin.y),
      Math.hypot(window.innerWidth - origin.x, origin.y),
      Math.hypot(origin.x, window.innerHeight - origin.y),
      Math.hypot(window.innerWidth - origin.x, window.innerHeight - origin.y)
    ) * 1.15;

  document.documentElement.style.setProperty('--transition-x', `${String(origin.x)}px`);
  document.documentElement.style.setProperty('--transition-y', `${String(origin.y)}px`);
  document.documentElement.style.setProperty('--transition-radius', `${String(maxRadius)}px`);

  const transition = document.startViewTransition(applyChange);

  void (async (): Promise<void> => {
    // Both promises need a handler, not just `finished`: `ready` rejects with
    // "Transition was skipped" whenever a transition is interrupted, and with
    // nothing attached to it that becomes a page-level unhandled rejection.
    await Promise.allSettled([transition.ready, transition.finished]);
    document.documentElement.style.removeProperty('--transition-x');
    document.documentElement.style.removeProperty('--transition-y');
    document.documentElement.style.removeProperty('--transition-radius');
  })();
}
