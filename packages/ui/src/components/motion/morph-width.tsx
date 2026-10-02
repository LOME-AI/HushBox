import * as React from 'react';
import { motion } from 'framer-motion';

import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { MOTION_TRANSITION } from './motion-transition';
import { useMeasuredSize } from './use-measured-size';

interface MorphWidthProps {
  children: React.ReactNode;
  'data-testid'?: string;
}

const WRAPPER_STYLE = {
  display: 'inline-block',
  overflow: 'hidden',
  verticalAlign: 'bottom',
} as const satisfies React.CSSProperties;

const CONTENT_STYLE: React.CSSProperties = { display: 'inline-block' };

/**
 * An inline wrapper that tweens its width to its content's measured width as the
 * content reflows, rather than snapping. It gates on the merged reduced-motion
 * signal itself, so it renders instantly in hosts that mount no `MotionConfig`.
 */
export function MorphWidth({
  children,
  'data-testid': testId,
}: Readonly<MorphWidthProps>): React.JSX.Element {
  const animated = !useReducedMotion();
  const { ref, size } = useMeasuredSize<HTMLSpanElement>('offsetWidth', animated);

  if (!animated) {
    return (
      <span data-testid={testId} data-animated="false" style={WRAPPER_STYLE}>
        <span style={CONTENT_STYLE}>{children}</span>
      </span>
    );
  }
  return (
    <motion.span
      data-testid={testId}
      data-animated="true"
      initial={false}
      animate={{ width: size }}
      transition={MOTION_TRANSITION.deliberate}
      style={WRAPPER_STYLE}
    >
      <span ref={ref} style={CONTENT_STYLE}>
        {children}
      </span>
    </motion.span>
  );
}
