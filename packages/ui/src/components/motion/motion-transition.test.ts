import { describe, it, expect } from 'vitest';
import { MOTION } from '@hushbox/shared/design-tokens';
import { MOTION_TRANSITION } from './motion-transition';

describe('MOTION_TRANSITION', () => {
  it('times the fast tween by the fast motion token', () => {
    expect(MOTION_TRANSITION.fast.duration).toBe(MOTION.fastMs / 1000);
  });

  it('times the base tween by the base motion token', () => {
    expect(MOTION_TRANSITION.base.duration).toBe(MOTION.baseMs / 1000);
  });

  it('times the slow tween by the slow motion token', () => {
    expect(MOTION_TRANSITION.slow.duration).toBe(MOTION.slowMs / 1000);
  });

  it('times the deliberate tween by the deliberate motion token', () => {
    expect(MOTION_TRANSITION.deliberate.duration).toBe(MOTION.deliberateMs / 1000);
  });

  it('eases every tween on the standard easing curve', () => {
    for (const transition of Object.values(MOTION_TRANSITION)) {
      expect(transition.ease).toStrictEqual(MOTION.easeStandard);
    }
  });
});
