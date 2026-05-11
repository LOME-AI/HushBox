import * as React from 'react';
import { MotionConfig } from 'framer-motion';
import { useA11yStore } from '../store';

interface MotionProviderProps {
  readonly children: React.ReactNode;
}

/**
 * Wraps children in framer-motion's MotionConfig with reducedMotion derived
 * from the accessibility store's `stopAnimations` boolean.
 */
export function MotionProvider({ children }: MotionProviderProps): React.JSX.Element {
  const stopAnimations = useA11yStore((s) => s.stopAnimations);
  const reducedMotion: 'always' | 'never' = stopAnimations ? 'always' : 'never';
  return <MotionConfig reducedMotion={reducedMotion}>{children}</MotionConfig>;
}
