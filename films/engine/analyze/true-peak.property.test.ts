import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { samplePeakDbfs } from './levels.js';
import { truePeakDbtp } from './true-peak.js';

describe('truePeakDbtp', () => {
  it('never reads below the sample peak (fast-check float32 arrays)', () => {
    fc.assert(
      fc.property(
        fc.float32Array({
          minLength: 1,
          maxLength: 64,
          min: -1,
          max: 1,
          noDefaultInfinity: true,
          noNaN: true,
        }),
        (samples) => {
          const signal = { left: samples, right: samples.toReversed() };
          expect(truePeakDbtp(signal)).toBeGreaterThanOrEqual(samplePeakDbfs(signal));
        }
      )
    );
  });
});
