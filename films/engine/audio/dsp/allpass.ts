import { STABLE_LOOP_GAIN, requireInRange } from './bounds.js';
import { createDelayLine, delayRange } from './delay.js';

export interface AllpassOptions {
  /** Samples, in [1, input length]; a fraction is read between samples. */
  delay: number;
  /** In (−1, 1). */
  gain: number;
}

/**
 * A Schroeder allpass: flat in magnitude at every frequency, it smears an
 * impulse into a decaying train of echoes `delay` samples apart. The output is
 * as long as the input.
 */
export function allpass(input: Float32Array, options: AllpassOptions): Float32Array {
  const gain = requireInRange('gain', options.gain, STABLE_LOOP_GAIN);
  const range = delayRange(input);
  const delay = requireInRange('delay', options.delay, range);
  const line = createDelayLine(range.max);
  return input.map((sample) => {
    const delayed = line.tap(delay - 1);
    const recirculated = sample + gain * delayed;
    line.write(recirculated);
    return delayed - gain * recirculated;
  });
}
