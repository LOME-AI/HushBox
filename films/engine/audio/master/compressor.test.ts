import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';
import { sine } from '../dsp/index.js';

import { compress } from './compressor.js';

import type { StereoBuffer } from '../dsp/index.js';
import type { CompressorOptions } from './compressor.js';

const OPTIONS: CompressorOptions = { thresholdDb: -18, ratio: 2, attack: 0.025, release: 0.15 };

function constant(samples: number, left: number, right: number): StereoBuffer {
  return {
    left: new Float32Array(samples).fill(left),
    right: new Float32Array(samples).fill(right),
  };
}

/** The static curve's gain reduction in dB for a level above the threshold. */
function staticReductionDb(level: number): number {
  return (20 * Math.log10(level) - OPTIONS.thresholdDb) * (1 - 1 / OPTIONS.ratio);
}

/** Gain reduction in dB at one sample: how far the output sits below the input. */
function reductionAt(input: Float32Array, output: Float32Array, index: number): number {
  return -20 * Math.log10((output[index] ?? Number.NaN) / (input[index] ?? Number.NaN));
}

describe('compress', () => {
  it('passes a signal that never crosses the threshold unchanged', () => {
    const tone = sine({ frequency: 1000, samples: SAMPLE_RATE / 10 }).map(
      (sample) => sample * 0.03
    );
    const output = compress({ left: tone, right: tone }, OPTIONS);
    expect([...output.left]).toEqual([...tone]);
    expect([...output.right]).toEqual([...tone]);
  });

  it('settles a steady level onto the static curve: ratio 2 halves the excess over the threshold', () => {
    const input = constant(SAMPLE_RATE, 0.5, 0.5);
    const output = compress(input, OPTIONS);
    expect(reductionAt(input.left, output.left, SAMPLE_RATE - 1)).toBeCloseTo(
      staticReductionDb(0.5),
      6
    );
  });

  it('links the channels: the quieter side is turned down by the louder side’s reduction', () => {
    const input = constant(SAMPLE_RATE, 0.5, 0.1);
    const output = compress(input, OPTIONS);
    const last = SAMPLE_RATE - 1;
    expect(reductionAt(input.right, output.right, last)).toBeCloseTo(
      reductionAt(input.left, output.left, last),
      // Both outputs are stored as float32, which holds a ratio to about 1e−7.
      5
    );
  });

  it('reaches 1 − 1/e of its reduction one attack time after the level steps up', () => {
    const input = constant(SAMPLE_RATE, 0.5, 0.5);
    const output = compress(input, OPTIONS);
    const reduction = reductionAt(input.left, output.left, OPTIONS.attack * SAMPLE_RATE - 1);
    expect(reduction / staticReductionDb(0.5)).toBeCloseTo(1 - Math.exp(-1), 3);
  });

  it('lets go to 1/e of its reduction one release time after the level falls below the threshold', () => {
    const input = constant(2 * SAMPLE_RATE, 0.5, 0.5);
    input.left.fill(0.01, SAMPLE_RATE);
    input.right.fill(0.01, SAMPLE_RATE);
    const output = compress(input, OPTIONS);
    const settled = reductionAt(input.left, output.left, SAMPLE_RATE - 1);
    const released = reductionAt(
      input.left,
      output.left,
      SAMPLE_RATE - 1 + OPTIONS.release * SAMPLE_RATE
    );
    expect(released / settled).toBeCloseTo(Math.exp(-1), 3);
  });

  it('outputs signals as long as its input', () => {
    const output = compress(constant(123, 0.5, 0.5), OPTIONS);
    expect(output.left).toHaveLength(123);
    expect(output.right).toHaveLength(123);
  });
});
