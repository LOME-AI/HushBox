/**
 * Trigger a View Transitions API circular-reveal animation from a click origin.
 * Falls back to calling applyChange() directly if the API is not supported.
 */
export function triggerViewTransition(
  origin: { x: number; y: number },
  applyChange: () => void
): void {
  if (typeof document === 'undefined' || !('startViewTransition' in document)) {
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
    try {
      await transition.finished;
    } catch {
      // Transition may be skipped or aborted
    } finally {
      document.documentElement.style.removeProperty('--transition-x');
      document.documentElement.style.removeProperty('--transition-y');
      document.documentElement.style.removeProperty('--transition-radius');
    }
  })();
}
