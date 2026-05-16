import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface AnimatedHeightProps {
  children: React.ReactNode;
}

/**
 * Wraps conditional children with a height/opacity transition. Used to prevent
 * layout shift when sibling content mounts and unmounts. The root MotionConfig
 * globally collapses this to instant under reduced motion — no per-component
 * check needed here.
 */
export function AnimatedHeight({ children }: Readonly<AnimatedHeightProps>): React.JSX.Element {
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
