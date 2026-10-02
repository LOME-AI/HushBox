import { SAMPLE_RATE } from '../../time/grid.js';
import { sampleAt } from '../dsp/index.js';

import type { StereoBuffer } from '../dsp/index.js';
import type { SampleSpan } from './define-score.js';

/** Samples faded out just before a silence span, so the cut into it does not click: 1 ms. */
export const SILENCE_FADE = Math.round(0.001 * SAMPLE_RATE);

function silencedChannel(channel: Float32Array, spans: readonly SampleSpan[]): Float32Array {
  const output = Float32Array.from(channel);
  for (const { from, to } of spans) {
    for (let index = Math.max(0, from - SILENCE_FADE); index < from; index++) {
      output[index] = sampleAt(output, index) * ((from - index) / SILENCE_FADE);
    }
    output.fill(0, from, to);
  }
  return output;
}

/** The bus at digital zero across every span, faded out over the millisecond before each. */
export function silenced(buffer: StereoBuffer, spans: readonly SampleSpan[]): StereoBuffer {
  return { left: silencedChannel(buffer.left, spans), right: silencedChannel(buffer.right, spans) };
}
