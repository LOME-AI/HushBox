import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';
import { createStereo, sine } from '../dsp/index.js';

import { softClip } from './soft-clip.js';

const CEILING = 0.5;
/** Far enough from either end that the oversampling filter's edge transient has passed. */
const EDGE = 256;

function tone(amplitude: number): Float32Array {
  return sine({ frequency: 1000, samples: SAMPLE_RATE / 10 }).map((sample) => sample * amplitude);
}

function peakAwayFromEdges(signal: Float32Array): number {
  let peak = 0;
  for (const sample of signal.subarray(EDGE, signal.length - EDGE)) {
    peak = Math.max(peak, Math.abs(sample));
  }
  return peak;
}

describe('softClip', () => {
  it('leaves a signal far below the ceiling where it was, sample for sample', () => {
    const quiet = tone(CEILING / 100);
    const { left } = softClip({ left: quiet, right: quiet }, CEILING);
    for (let index = EDGE; index < quiet.length - EDGE; index++) {
      expect(Math.abs((left[index] ?? Number.NaN) - (quiet[index] ?? Number.NaN))).toBeLessThan(
        CEILING / 1e5
      );
    }
  });

  it('rounds a signal twice the ceiling down to ceiling × tanh(2)', () => {
    const loud = tone(2 * CEILING);
    const { right } = softClip({ left: loud, right: loud }, CEILING);
    expect(peakAwayFromEdges(right) / CEILING).toBeCloseTo(Math.tanh(2), 2);
  });

  it('keeps silence silent', () => {
    const { left, right } = softClip(createStereo(64), CEILING);
    expect(left.every((sample) => sample === 0)).toBe(true);
    expect(right.every((sample) => sample === 0)).toBe(true);
  });
});
