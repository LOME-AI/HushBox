import { SAMPLE_RATE } from '../time/grid.js';
import { pow } from '../dmath/dmath.js';

import { powerToDb } from './decibels.js';
import { kWeightStereo } from './k-weighting.js';
import { requireStereo } from './signal.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { WeightedStereo } from './k-weighting.js';

/** Gating blocks overlap by 75%, so every window advances in 100 ms steps. */
const STEP = SAMPLE_RATE / 10;
const MOMENTARY_STEPS = 4;
const SHORT_TERM_STEPS = 30;

/** The momentary (and gating block) window: 400 ms. */
export const MOMENTARY_WINDOW = MOMENTARY_STEPS * STEP;

/** The short-term window: 3 s. */
export const SHORT_TERM_WINDOW = SHORT_TERM_STEPS * STEP;

/** BS.1770's offset from mean-square power to loudness, in LU. */
const LOUDNESS_OFFSET = -0.691;

/** The combined block power at −70 LKFS; a block is kept only above it. */
export const ABSOLUTE_GATE_POWER = pow(10, (-70 - LOUDNESS_OFFSET) / 10);

/** The relative gate sits 10 LU below the mean of the kept blocks: a power ratio of exactly ten. */
const RELATIVE_GATE_RATIO = 10;

export interface Loudness {
  /** ITU-R BS.1770-4 gated integrated loudness. */
  readonly integratedLufs: number;
  readonly maxMomentaryLufs: number;
  readonly maxShortTermLufs: number;
}

/** Loudness of a combined (left plus right) mean-square power; silence reads −Infinity. */
export function blockLoudness(power: number): number {
  return LOUDNESS_OFFSET + powerToDb(power);
}

/**
 * Integrated loudness from gating-block powers: blocks above the absolute gate,
 * then above the relative gate, averaged in power. −Infinity when none pass.
 */
export function gatedLoudness(blockPowers: Float64Array): number {
  let sum = 0;
  let count = 0;
  for (const power of blockPowers) {
    if (power > ABSOLUTE_GATE_POWER) {
      sum += power;
      count += 1;
    }
  }
  if (count === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const relativeGate = sum / count / RELATIVE_GATE_RATIO;
  let gatedSum = 0;
  let gatedCount = 0;
  for (const power of blockPowers) {
    if (power > ABSOLUTE_GATE_POWER && power > relativeGate) {
      gatedSum += power;
      gatedCount += 1;
    }
  }
  return blockLoudness(gatedSum / gatedCount);
}

function sumOfSquares(samples: Float64Array): number {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return sum;
}

/** The summed squared K-weighted samples of both channels over [start, start + length). */
function energy(weighted: WeightedStereo, start: number, length: number): number {
  const end = start + length;
  return (
    sumOfSquares(weighted.left.subarray(start, end)) +
    sumOfSquares(weighted.right.subarray(start, end))
  );
}

/** Momentary loudness of the 400 ms window starting at `start`, which must lie inside the signal. */
export function momentaryLufsAt(weighted: WeightedStereo, start: number): number {
  const { length } = weighted.left;
  if (!Number.isInteger(start) || start < 0 || start + MOMENTARY_WINDOW > length) {
    throw new RangeError(
      `a 400 ms window starting at sample ${String(start)} does not lie inside a signal of ${String(length)} samples`
    );
  }
  return blockLoudness(energy(weighted, start, MOMENTARY_WINDOW) / MOMENTARY_WINDOW);
}

/** The combined power of every complete window of `steps` steps, advancing one step at a time. */
function windowPowers(stepEnergies: Float64Array, steps: number): Float64Array {
  const count = Math.max(0, stepEnergies.length - steps + 1);
  const powers = new Float64Array(count);
  for (let first = 0; first < count; first += 1) {
    let sum = 0;
    for (const stepEnergy of stepEnergies.subarray(first, first + steps)) {
      sum += stepEnergy;
    }
    powers[first] = sum / (steps * STEP);
  }
  return powers;
}

function maxLoudness(powers: Float64Array): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const power of powers) {
    max = Math.max(max, power);
  }
  return max === Number.NEGATIVE_INFINITY ? max : blockLoudness(max);
}

/**
 * Integrated, maximum momentary and maximum short-term loudness over complete
 * windows only; a figure with no complete window, or of silence, reads −Infinity.
 */
export function measureLoudness(signal: StereoBuffer): Loudness {
  const length = requireStereo(signal);
  const weighted = kWeightStereo(signal);
  const stepEnergies = Float64Array.from({ length: Math.floor(length / STEP) }, (_, step) =>
    energy(weighted, step * STEP, STEP)
  );
  const momentary = windowPowers(stepEnergies, MOMENTARY_STEPS);
  return {
    integratedLufs: gatedLoudness(momentary),
    maxMomentaryLufs: maxLoudness(momentary),
    maxShortTermLufs: maxLoudness(windowPowers(stepEnergies, SHORT_TERM_STEPS)),
  };
}
