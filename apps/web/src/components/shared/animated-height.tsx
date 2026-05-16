import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useReducedMotion } from '@hushbox/ui';

interface AnimatedHeightProps {
  children: React.ReactNode;
}

/**
 * Wraps conditional children with a height/opacity transition. Used to prevent
 * layout shift when sibling content mounts and unmounts. When the user prefers
 * reduced motion, falls back to instant mount/unmount with no animation.
 */
export function AnimatedHeight({ children }: Readonly<AnimatedHeightProps>): React.JSX.Element {
  const reducedMotion = useReducedMotion();

  if (reducedMotion) {
    return <>{children ? <div>{children}</div> : null}</>;
  }

  return (
    <AnimatePresence mode="wait">
      {children ? (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
