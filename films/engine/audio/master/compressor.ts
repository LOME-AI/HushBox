import { amplitudeToDb, dbToAmplitude } from '../../analyze/index.js';
import { exp } from '../../dmath/dmath.js';
import { SAMPLE_RATE } from '../../time/grid.js';
import { createStereo, sampleAt } from '../dsp/index.js';

import type { StereoBuffer } from '../dsp/index.js';

export interface CompressorOptions {
  /** dBFS: the level above which the gain comes down. */
  thresholdDb: number;
  /** How many dB in it takes to raise the output one dB, above the threshold. */
  ratio: number;
  /** Seconds: the time constant of the reduction's rise. */
  attack: number;
  /** Seconds: the time constant of the reduction's fall. */
  release: number;
}

/** The pole of a one-pole smoother whose time constant is `seconds`. */
function smoothing(seconds: number): number {
  return exp(-1 / (seconds * SAMPLE_RATE));
}

/**
 * A feed-forward compressor, stereo-linked on the louder channel. The static
 * curve's reduction is smoothed in dB, rising with the attack and falling with
 * the release, so the gain has no lookahead and adds no latency.
 */
export function compress(input: StereoBuffer, options: CompressorOptions): StereoBuffer {
  const threshold = dbToAmplitude(options.thresholdDb);
  const slope = 1 - 1 / options.ratio;
  const attack = smoothing(options.attack);
  const release = smoothing(options.release);
  const output = createStereo(input.left.length);
  let reductionDb = 0;
  for (const [index, left] of input.left.entries()) {
    const right = sampleAt(input.right, index);
    const level = Math.max(Math.abs(left), Math.abs(right));
    const target = level > threshold ? (amplitudeToDb(level) - options.thresholdDb) * slope : 0;
    const pole = target > reductionDb ? attack : release;
    reductionDb = pole * reductionDb + (1 - pole) * target;
    const gain = dbToAmplitude(-reductionDb);
    output.left[index] = left * gain;
    output.right[index] = right * gain;
  }
  return output;
}
