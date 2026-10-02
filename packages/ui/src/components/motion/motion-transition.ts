import { MOTION } from '@hushbox/shared/design-tokens';

interface MotionTween {
  readonly duration: number;
  readonly ease: typeof MOTION.easeStandard;
}

function tween(milliseconds: number): MotionTween {
  return { duration: milliseconds / 1000, ease: MOTION.easeStandard };
}

/** The motion tokens as framer-motion transitions: framer reads seconds where the tokens hold milliseconds. */
export const MOTION_TRANSITION = {
  fast: tween(MOTION.fastMs),
  base: tween(MOTION.baseMs),
  slow: tween(MOTION.slowMs),
  deliberate: tween(MOTION.deliberateMs),
} as const;
