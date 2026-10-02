import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { MOTION_TRANSITION } from './motion-transition';
import { useMeasuredSize } from './use-measured-size';

interface CollapseProps {
  open: boolean;
  children: React.ReactNode;
}

// Vertical clip only: the height tween needs it, while a horizontal clip swallows
// taps on children that overflow sideways, because Android WebView hit-testing
// respects the clip.
const CLIP = 'overflow-y-hidden';

/**
 * Opens and closes its content with a height tween, and while open follows the
 * content's measured height as it changes. It gates on the merged reduced-motion
 * signal itself rather than on a mounted `MotionConfig`, so it renders instantly
 * in hosts that mount none. `data-animated` reflects that state for tests.
 */
export function Collapse({ open, children }: Readonly<CollapseProps>): React.JSX.Element | null {
  const animated = !useReducedMotion();
  const { ref, size } = useMeasuredSize<HTMLDivElement>('offsetHeight', animated);

  if (!animated) {
    return open ? (
      <div data-animated="false" className={CLIP}>
        {children}
      </div>
    ) : null;
  }
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          data-animated="true"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: size, opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={MOTION_TRANSITION.base}
          className={CLIP}
        >
          <div ref={ref}>{children}</div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
