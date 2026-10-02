import { sin } from '../../dmath/dmath.js';

import { FINITE, NON_NEGATIVE_FINITE, requireInRange } from './bounds.js';
import { createStereo, requireEqualChannels, sampleAt } from './buffer.js';

import type { Interval } from './bounds.js';
import type { StereoBuffer } from './buffer.js';

/** Where and how loud a source lands in a mix. */
export interface Placement {
  /** The target sample the source's first sample lands on; any safe integer, negative included. */
  atSample: number;
  /** Any finite number; negative inverts the polarity. */
  gain: number;
  /** In [−1, 1]: −1 hard left, 0 centre, 1 hard right. */
  pan: number;
}

const PAN: Interval = { min: -1, max: 1 };
const QUARTER_PI = Math.PI / 4;

/**
 * The constant-power pan law: left = sin((1 − pan)·π/4), right = sin((1 + pan)·π/4).
 * Written with `sin` on both sides, rather than cos and sin of one angle, so the
 * centre gives both sides the same bits and a hard pan silences the far side exactly.
 */
export function panGains(position: number): readonly [left: number, right: number] {
  requireInRange('pan', position, PAN);
  return [sin((1 - position) * QUARTER_PI), sin((1 + position) * QUARTER_PI)];
}

/** A mono signal placed in the stereo field by the constant-power law. */
export function pan(input: Float32Array, position: number): StereoBuffer {
  const [leftGain, rightGain] = panGains(position);
  return {
    left: input.map((sample) => sample * leftGain),
    right: input.map((sample) => sample * rightGain),
  };
}

/** Scales the side signal (L − R)/2 by `amount` against the mid (L + R)/2: 0 is mono, 1 unchanged. */
export function width(input: StereoBuffer, amount: number): StereoBuffer {
  requireEqualChannels(input);
  requireInRange('width', amount, NON_NEGATIVE_FINITE);
  const output = createStereo(input.left.length);
  for (const [index, left] of input.left.entries()) {
    const right = sampleAt(input.right, index);
    const mid = (left + right) / 2;
    const side = ((left - right) / 2) * amount;
    output.left[index] = mid + side;
    output.right[index] = mid - side;
  }
  return output;
}

function requireSampleIndex(name: string, value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a whole sample index, got ${String(value)}`);
  }
  return value;
}

/**
 * Sums a source into the target from `atSample` on. A mono source is panned by
 * the constant-power law; a stereo source keeps its channels, balanced by the
 * same law scaled by √2 so the centre is unity in each. Source samples that fall
 * before the target's start or past its end are dropped.
 */
export function mixInto(
  target: StereoBuffer,
  source: Float32Array | StereoBuffer,
  placement: Placement
): void {
  requireEqualChannels(target);
  const atSample = requireSampleIndex('atSample', placement.atSample);
  const gain = requireInRange('gain', placement.gain, FINITE);
  const [leftGain, rightGain] = panGains(placement.pan);
  const mono = source instanceof Float32Array;
  const channels = mono ? { left: source, right: source } : source;
  requireEqualChannels(channels);
  const scale = mono ? gain : gain * Math.SQRT2;
  const first = Math.max(0, -atSample);
  const end = Math.min(channels.left.length, target.left.length - atSample);
  for (let index = first; index < end; index++) {
    const at = atSample + index;
    target.left[at] = sampleAt(target.left, at) + sampleAt(channels.left, index) * scale * leftGain;
    target.right[at] =
      sampleAt(target.right, at) + sampleAt(channels.right, index) * scale * rightGain;
  }
}
