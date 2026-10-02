import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { MOTION_TRANSITION } from './motion-transition';

interface PresenceProps {
  children: React.ReactNode;
  /** False skips the entry fade for the children present on first render. */
  initial?: boolean;
}

/**
 * Fades each child in as it enters and out as it leaves, one wrapper per child
 * keyed by the child's own key, so siblings come and go independently. It gates
 * on the merged reduced-motion signal itself, so it renders instantly in hosts
 * that mount no `MotionConfig`.
 */
export function Presence({ children, initial = true }: Readonly<PresenceProps>): React.JSX.Element {
  const animated = !useReducedMotion();
  const items = React.Children.toArray(children);

  if (!animated) {
    return (
      <>
        {items.map((child, index) => (
          <div key={keyOf(child, index)} data-animated="false">
            {child}
          </div>
        ))}
      </>
    );
  }
  return (
    <AnimatePresence initial={initial}>
      {items.map((child, index) => (
        <motion.div
          key={keyOf(child, index)}
          data-animated="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={MOTION_TRANSITION.base}
        >
          {child}
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

function keyOf(child: React.ReactNode, index: number): React.Key {
  return React.isValidElement(child) && child.key !== null ? child.key : index;
}
