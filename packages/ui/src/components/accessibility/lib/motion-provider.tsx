import * as React from 'react';
import { MotionConfig } from 'framer-motion';
import { useReducedMotion } from '../../../hooks/use-reduced-motion';

interface MotionProviderProps {
  readonly children: React.ReactNode;
}

/**
 * Wraps children in framer-motion's MotionConfig with reducedMotion AND
 * skipAnimations derived from the merged reduced-motion signal (OS
 * `prefers-reduced-motion: reduce` OR the a11y widget's "Stop animations"
 * toggle).
 *
 * Both props are required: `reducedMotion="always"` only zeros animations on
 * positional keys (width/height/transform/scale/etc.) — opacity, color, and
 * non-transform values still animate at full duration. `skipAnimations` is the
 * documented "skip every animation" escape hatch (per framer-motion source:
 * "all animations will be skipped and values will be set instantly"). Either
 * input alone forces every motion.* descendant to jump to its end state with
 * no per-component check.
 */
export function MotionProvider({ children }: MotionProviderProps): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  return (
    <MotionConfig reducedMotion={reducedMotion ? 'always' : 'never'} skipAnimations={reducedMotion}>
      {children}
    </MotionConfig>
  );
}
