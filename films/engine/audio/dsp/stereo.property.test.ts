import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { panGains } from './stereo.js';

describe('panGains', () => {
  it('keeps the summed power at 1 across the whole range', () => {
    // Generator: `fc.double` over [−1, 1], NaN excluded.
    fc.assert(
      fc.property(fc.double({ min: -1, max: 1, noNaN: true }), (position) => {
        const [left, right] = panGains(position);
        expect(left * left + right * right).toBeCloseTo(1, 15);
      })
    );
  });
});
