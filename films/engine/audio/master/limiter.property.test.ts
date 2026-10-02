import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { forwardMinimum, limit, truePeakKey } from './limiter.js';

function bruteForwardMinimum(values: readonly number[], width: number): number[] {
  return values.map((_, index) => Math.min(...values.slice(index, index + width)));
}

function largest(channel: Float32Array): number {
  let peak = 0;
  for (const sample of channel) {
    peak = Math.max(peak, Math.abs(sample));
  }
  return peak;
}

const signal = fc.float32Array({ minLength: 1, maxLength: 400, min: -4, max: 4, noNaN: true });

describe('forwardMinimum', () => {
  it('matches the minimum taken window by window: fc.array(fc.double()) values, fc.integer() widths', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ noNaN: true, noDefaultInfinity: true }), { maxLength: 60 }),
        fc.integer({ min: 1, max: 20 }),
        (values, width) => {
          expect([...forwardMinimum(Float64Array.from(values), width)]).toEqual(
            bruteForwardMinimum(values, width)
          );
        }
      )
    );
  });
});

describe('limit', () => {
  it('never lets a sample past the ceiling: fc.float32Array() signals, fc.double() gains and ceilings', () => {
    fc.assert(
      fc.property(
        signal,
        signal,
        fc.double({ min: 0.1, max: 10, noNaN: true }),
        fc.double({ min: 0.1, max: 1, noNaN: true }),
        (left, rightSource, gain, ceiling) => {
          const right = new Float32Array(left.length);
          right.set(rightSource.subarray(0, left.length));
          const input = { left, right };
          const output = limit(input, truePeakKey(input), { gain, ceiling });
          // The output is stored as float32, whose rounding may lift a sample by half an ulp.
          const allowed = ceiling * (1 + 2 ** -23);
          expect(Math.max(largest(output.left), largest(output.right))).toBeLessThanOrEqual(
            allowed
          );
        }
      )
    );
  });
});
