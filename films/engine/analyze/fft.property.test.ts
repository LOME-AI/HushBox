import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { fft } from './fft.js';

/** The DFT by its definition, in `Math`: the reference the FFT is held to. */
function naiveDft(real: readonly number[]): { real: number[]; imag: number[] } {
  const size = real.length;
  const out = { real: [] as number[], imag: [] as number[] };
  for (let bin = 0; bin < size; bin += 1) {
    let re = 0;
    let im = 0;
    for (const [index, value] of real.entries()) {
      const angle = (-2 * Math.PI * bin * index) / size;
      re += value * Math.cos(angle);
      im += value * Math.sin(angle);
    }
    out.real.push(re);
    out.imag.push(im);
  }
  return out;
}

describe('fft', () => {
  it('matches the DFT definition on random real input (fast-check doubles, length 32)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 32, maxLength: 32 }),
        (values) => {
          const real = Float64Array.from(values);
          const imag = new Float64Array(32);
          fft(real, imag);
          const expected = naiveDft(values);
          for (let bin = 0; bin < 32; bin += 1) {
            expect(real[bin]).toBeCloseTo(expected.real[bin] ?? Number.NaN, 10);
            expect(imag[bin]).toBeCloseTo(expected.imag[bin] ?? Number.NaN, 10);
          }
        }
      )
    );
  });
});
