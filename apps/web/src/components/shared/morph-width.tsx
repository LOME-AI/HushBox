import * as React from 'react';
import { motion } from 'framer-motion';
import { useMeasuredSize } from '@/hooks/use-measured-size';

interface MorphWidthProps {
  children: React.ReactNode;
  duration?: number;
  'data-testid'?: string;
}

/**
 * Inline-flow analogue of [[MorphHeight]]: as `children` reflow to a new
 * natural width, the outer wrapper tweens its width from the previous value
 * to the new measured value rather than snapping. Used for label text that
 * cycles between strings of different lengths (e.g. modality-aware pills).
 * The root MotionConfig globally collapses the tween to instant under
 * reduced motion.
 */
// 0.5s default: roughly matches typewriter deletion for short labels.
// Callers (e.g. SuggestionChips) override upward to track longer labels.
export function MorphWidth({
  children,
  duration = 0.5,
  'data-testid': testId,
}: Readonly<MorphWidthProps>): React.JSX.Element {
  const { ref: contentRef, size: width } = useMeasuredSize<HTMLSpanElement>('width', true);

  return (
    <motion.span
      data-testid={testId}
      initial={false}
      animate={{ width }}
      transition={{ duration, ease: 'easeInOut' }}
      style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'bottom' }}
    >
      <span ref={contentRef} style={{ display: 'inline-block' }}>
        {children}
      </span>
    </motion.span>
  );
}
