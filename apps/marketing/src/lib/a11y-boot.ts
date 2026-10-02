import { REDUCED_MOTION_CLASS } from '@hushbox/ui/accessibility';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import { env } from './env.js';

/**
 * Hand @hushbox/ui the host's reduced-motion override.
 *
 * The library derives reduced motion from the a11y store and never reads the
 * build environment, so each host app supplies the E2E override itself. E2E
 * builds force it on because Playwright's prefers-reduced-motion emulation does
 * not reliably reach WebKit.
 *
 * Called from the module body of the accessibility-provider island, so the
 * override is in the store before the provider's broadcaster reads it.
 */
export function applyForcedReducedMotion(): void {
  useA11yStore.getState().setForcedReducedMotion(env.isE2E);
}

/**
 * The class the layouts stamp on `<html>` at build time, or `undefined` when
 * the build is not an E2E build.
 *
 * Suppression has to be in the served bytes, not in a script: this is a
 * multi-island static site, each island hydrates on its own schedule, and the
 * broadcaster that would otherwise add the class runs in a React effect inside
 * one of those islands — so any island hydrating first gets an animated frame.
 * Markup is the only thing that precedes all of them.
 */
export const forcedReducedMotionClass: string | undefined = env.isE2E
  ? REDUCED_MOTION_CLASS
  : undefined;
