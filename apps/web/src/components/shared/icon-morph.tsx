import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn, useReducedMotion } from '@hushbox/ui';
import type { LucideIcon } from 'lucide-react';

interface IconMorphProps {
  icon: LucideIcon;
  iconKey: string;
  sizeClassName?: string;
  className?: string;
  duration?: number;
  'data-testid'?: string;
}

/**
 * Cross-fades between Lucide icons as the `iconKey` prop changes. The slot
 * size is fixed via `sizeClassName` so the surrounding layout does not jump
 * during the swap. Reduced-motion users get an instant icon swap.
 */
export function IconMorph({
  icon: Icon,
  iconKey,
  sizeClassName = 'h-4 w-4',
  className,
  duration = 1,
  'data-testid': testId,
}: Readonly<IconMorphProps>): React.JSX.Element {
  const reducedMotion = useReducedMotion();

  if (reducedMotion) {
    return (
      <span
        data-testid={testId}
        aria-hidden="true"
        className={cn('relative inline-flex items-center justify-center', sizeClassName, className)}
      >
        <Icon className={sizeClassName} aria-hidden="true" />
      </span>
    );
  }

  return (
    <span
      data-testid={testId}
      aria-hidden="true"
      className={cn('relative inline-flex items-center justify-center', sizeClassName, className)}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={iconKey}
          initial={{ opacity: 0, scale: 0.6, rotate: -45 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          exit={{ opacity: 0, scale: 0.6, rotate: 45 }}
          transition={{ duration, ease: 'easeOut' }}
          className="absolute inset-0 inline-flex items-center justify-center"
        >
          <Icon className={sizeClassName} aria-hidden="true" />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
