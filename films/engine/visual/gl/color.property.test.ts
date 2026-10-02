import fc from 'fast-check';
import { expect, it } from 'vitest';

import { srgbToLinear } from './color.js';

it('srgbToLinear never decreases', () => {
  // Generator: pairs of channel values in [0, 1].
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      (a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(srgbToLinear(low)).toBeLessThanOrEqual(srgbToLinear(high));
      }
    )
  );
});
