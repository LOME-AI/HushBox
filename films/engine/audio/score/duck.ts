import { sampleAt } from '../dsp/index.js';

import type { StereoBuffer } from '../dsp/index.js';
import type { Duck } from './define-score.js';

/**
 * A sidechain's gain per sample: unity, dropping to the floor on each cue's
 * sample and recovering as floor + (1 − floor)·u^1.5 over the release, u its
 * progress; where two ducks overlap, the deeper holds. Computed from the cues
 * themselves, so the duck can never drift from the hits it answers.
 */
export function duckGains(samples: number, duck: Duck): Float32Array {
  const { floor, releaseSamples } = duck;
  const gains = new Float32Array(samples).fill(1);
  for (const cue of duck.cueSamples) {
    const end = Math.min(samples, cue + releaseSamples);
    for (let index = cue; index < end; index++) {
      const progress = (index - cue) / releaseSamples;
      const gain = floor + (1 - floor) * progress * Math.sqrt(progress);
      gains[index] = Math.min(sampleAt(gains, index), gain);
    }
  }
  return gains;
}

/** The bus under its sidechain's gains. */
export function applyDuck(buffer: StereoBuffer, duck: Duck): StereoBuffer {
  const gains = duckGains(buffer.left.length, duck);
  return {
    left: buffer.left.map((sample, index) => sample * sampleAt(gains, index)),
    right: buffer.right.map((sample, index) => sample * sampleAt(gains, index)),
  };
}
