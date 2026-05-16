import { shouldReduceMotion, subscribeReducedMotion } from '../../../hooks/use-reduced-motion';

const REDUCED_MOTION_CLASS = 'reduced-motion';

function applyReducedMotionClass(reduced: boolean): void {
  document.documentElement.classList.toggle(REDUCED_MOTION_CLASS, reduced);
}

/**
 * Mirror the merged reduced-motion signal onto `html.reduced-motion`.
 *
 * Apply the current state synchronously on install, then subscribe so future
 * changes to either input (OS `prefers-reduced-motion: reduce` or the a11y
 * store's `stopAnimations` toggle) flip the class. The class is the single
 * CSS hook every reduce-motion rule keys off — broadcasters cannot drift
 * because they all read [[shouldReduceMotion]].
 *
 * Returns a cleanup that stops the subscription. Class state at cleanup time
 * is left as-is; the next reinstall re-applies the current truth.
 */
export function installReducedMotionClass(): () => void {
  applyReducedMotionClass(shouldReduceMotion());
  return subscribeReducedMotion(applyReducedMotionClass);
}
