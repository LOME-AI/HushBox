import { A11yProvider as LibraryA11yProvider } from '@hushbox/ui/accessibility';
import { applyForcedReducedMotion } from '../lib/a11y-boot.js';
import type * as React from 'react';

/**
 * The accessibility provider island, wrapped so the host's reduced-motion
 * override reaches the store before the library's provider can read it.
 *
 * The call sits in this module's body on purpose. The provider installs
 * `html.reduced-motion` from `shouldReduceMotion()` in an effect, and would
 * clear a class it disagrees with; an ES module body is guaranteed to run
 * before anything the module exports is used, so the override is ordered by the
 * module graph rather than by which chunk's response arrives first.
 */
applyForcedReducedMotion();

export function A11yProvider(): React.JSX.Element {
  return <LibraryA11yProvider />;
}
