import * as React from 'react';
import { MotionConfig } from 'framer-motion';
import { useA11yStore } from '../store';
import { useOsPreferences } from '../hooks/use-os-preferences';

interface MotionProviderProps {
  readonly children: React.ReactNode;
}

/**
 * Wraps children in framer-motion's MotionConfig with reducedMotion derived from:
 * - Accessibility store stopAnimations setting (system / force-on / force-off)
 * - OS prefers-reduced-motion (when stopAnimations is 'system')
 *
 * Resolution table:
 * | stopAnimations | OS reduced | reducedMotion |
 * |----------------|------------|---------------|
 * | force-on       | (any)      | 'always'      |
 * | force-off      | (any)      | 'never'       |
 * | system         | true       | 'always'      |
 * | system         | false      | 'never'       |
 */
export function MotionProvider({ children }: MotionProviderProps): React.JSX.Element {
  const stopAnimations = useA11yStore((s) => s.stopAnimations);
  const { reducedMotion: osReduced } = useOsPreferences();

  const reducedMotion: 'always' | 'never' = (() => {
    if (stopAnimations === 'force-on') return 'always';
    if (stopAnimations === 'force-off') return 'never';
    return osReduced ? 'always' : 'never';
  })();

  return <MotionConfig reducedMotion={reducedMotion}>{children}</MotionConfig>;
}
