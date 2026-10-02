import fc from 'fast-check';
import { expect, it } from 'vitest';

import { gaussianKernel } from './post.js';

it('gaussianKernel sums to 1 across both sides and the centre', () => {
  // Generator: radii from 1 to 32 taps and widths from a quarter tap to 16 taps.
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 32 }),
      fc.double({ min: 0.25, max: 16, noNaN: true }),
      (radius, sigma) => {
        const [centre = 0, ...side] = gaussianKernel(radius, sigma);
        expect(centre + 2 * side.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 12);
      }
    )
  );
});
