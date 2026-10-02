import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cos, exp, log, sin } from './dmath.js';
import { ulpDistance } from './dmath-test-support.js';

describe('identities', () => {
  it('exp(log(x)) is within 2 ulp of x', () => {
    // Generator: `fc.double` over [0.25, 4]. log(x) is rounded to an ulp of
    // log(x), and exp scales that rounding by x, so the identity can hold to
    // 2 ulp only while |log x| stays below 2; this band keeps it below 1.4.
    fc.assert(
      fc.property(fc.double({ min: 0.25, max: 4, noNaN: true }), (x) => {
        expect(ulpDistance(exp(log(x)), x)).toBeLessThanOrEqual(2);
      }),
      { numRuns: 10_000 }
    );
  });

  it('sin²(x) + cos²(x) is within 4 ulp of 1', () => {
    // Generator: `fc.double` over [−1e4, 1e4], the sin and cos accuracy domain.
    fc.assert(
      fc.property(fc.double({ min: -1e4, max: 1e4, noNaN: true }), (x) => {
        const s = sin(x);
        const c = cos(x);
        expect(ulpDistance(s * s + c * c, 1)).toBeLessThanOrEqual(4);
      }),
      { numRuns: 10_000 }
    );
  });
});
