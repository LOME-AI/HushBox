import * as React from 'react';
import { motion } from 'framer-motion';
import { useMeasuredSize } from '@/hooks/use-measured-size';

interface MorphHeightProps {
  children: React.ReactNode;
}

/**
 * Smoothly morphs height from old to new content size as `children` changes.
 * Unlike a mount/unmount transition, the inner content is always rendered
 * and the outer wrapper animates its height directly via ResizeObserver — so
 * swapping sibling trees does not collapse the box to zero between states.
 * The root MotionConfig globally collapses the morph to instant under
 * reduced motion.
 */
export function MorphHeight({ children }: Readonly<MorphHeightProps>): React.JSX.Element {
  const { ref: contentRef, size: height } = useMeasuredSize<HTMLDivElement>('height', true);

  return (
    <motion.div
      initial={false}
      animate={{ height }}
      // 0.25s: bottom-row modality swap is short and decorative; longer durations
      // make the input feel laggy on every modality click.
      transition={{ duration: 0.25, ease: 'easeInOut' }}
      className="overflow-hidden"
    >
      <div ref={contentRef}>{children}</div>
    </motion.div>
  );
}
