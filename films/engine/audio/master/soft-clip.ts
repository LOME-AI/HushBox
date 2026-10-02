import { saturate } from '../dsp/index.js';

import type { StereoBuffer } from '../dsp/index.js';

/**
 * `ceiling · tanh(x / ceiling)`, four times oversampled: unity far below the
 * ceiling, rounding off whatever approaches it, never passing it by more than
 * the oversampling filter's ripple. The output is aligned with the input.
 */
export function softClip(input: StereoBuffer, ceiling: number): StereoBuffer {
  const drive = 1 / ceiling;
  const channel = (signal: Float32Array): Float32Array =>
    saturate(signal, drive).map((sample) => sample * ceiling);
  return { left: channel(input.left), right: channel(input.right) };
}
