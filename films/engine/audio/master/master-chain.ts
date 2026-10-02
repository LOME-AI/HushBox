import { dbToAmplitude, measureLoudness, truePeakDbtp } from '../../analyze/index.js';
import { svf } from '../dsp/index.js';

import { compress } from './compressor.js';
import { limit, truePeakKey } from './limiter.js';
import { softClip } from './soft-clip.js';

import type { StereoBuffer } from '../dsp/index.js';
import type { CompressorOptions } from './compressor.js';

/** The delivery loudness every master lands on unless its score says otherwise. */
export const DEFAULT_TARGET_LUFS = -14;

/** The true peak no master passes unless its score says otherwise. */
export const DEFAULT_CEILING_DBTP = -1;

export interface MasterOptions {
  /** Integrated loudness, ITU-R BS.1770-4. */
  targetLufs: number;
  /** The highest true peak allowed. */
  ceilingDbtp: number;
}

/** Sub-sonic energy costs headroom and no speaker plays it. */
const SUBSONIC_CUTOFF_HZ = 25;
/** q = 1/√2 in the filter's resonance terms: a Butterworth response, flat to the corner. */
const BUTTERWORTH_RESONANCE = 1 - Math.SQRT1_2;

/**
 * The loudness the mix is brought to before the glue compressor, so that its
 * threshold sits in the same place against every mix, whatever its tracks' gains.
 */
const REFERENCE_LUFS = -20;

/** A gentle 2:1 glue: slow enough to let transients through, taking a few dB off the body. */
const GLUE: CompressorOptions = { thresholdDb: -18, ratio: 2, attack: 0.025, release: 0.15 };

/**
 * The soft clipper's ceiling as a multiple of the compressed mix's sample peak:
 * at 1.5 the loudest transient loses about 1.2 dB and anything 20 dB under it
 * is left practically untouched.
 */
const SOFT_CLIP_HEADROOM = 1.5;

/**
 * dB kept between the measured true peak and the ceiling, which covers the
 * dither added when the master is written; the limiter aims a margin lower still.
 */
const TRUE_PEAK_MARGIN_DB = 0.05;
const LOUDNESS_TOLERANCE_LU = 0.05;
const MAX_PASSES = 12;
/**
 * The least loudness gained per dB of gain the loop assumes. Heavy limiting
 * gives back far less than a dB per dB, and a step sized for one would stall.
 */
const MIN_SLOPE = 0.1;

function requireFinite(name: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number, got ${String(value)}`);
  }
  return value;
}

function scaled(buffer: StereoBuffer, gain: number): StereoBuffer {
  return {
    left: buffer.left.map((sample) => sample * gain),
    right: buffer.right.map((sample) => sample * gain),
  };
}

function samplePeak(buffer: StereoBuffer): number {
  let peak = 0;
  for (const channel of [buffer.left, buffer.right]) {
    for (const sample of channel) {
      peak = Math.max(peak, Math.abs(sample));
    }
  }
  return peak;
}

function subsonicChannel(signal: Float32Array): Float32Array {
  return svf(signal, {
    mode: 'highpass',
    cutoff: SUBSONIC_CUTOFF_HZ,
    resonance: BUTTERWORTH_RESONANCE,
  });
}

/** A second-order Butterworth high-pass at 25 Hz: causal, so it moves no onset earlier. */
export function subsonicHighPass(mix: StereoBuffer): StereoBuffer {
  return { left: subsonicChannel(mix.left), right: subsonicChannel(mix.right) };
}

/** Loudness gained per dB of gain between two passes, bounded to [MIN_SLOPE, 1]; NaN reads as MIN_SLOPE. */
function slopeBetween(
  previous: { gainDb: number; lufs: number } | null,
  current: { gainDb: number; lufs: number }
): number {
  if (previous === null) {
    return 1;
  }
  const slope = (current.lufs - previous.lufs) / (current.gainDb - previous.gainDb);
  return slope >= MIN_SLOPE ? Math.min(slope, 1) : MIN_SLOPE;
}

/**
 * Finds the gain into the limiter that lands the target loudness: limit,
 * measure loudness and true peak with the analysis tree's meter, correct, and
 * repeat. A true peak over the ceiling lowers the limiter's own ceiling by the
 * excess, so the meter, not the limiter's estimate, has the last word.
 */
function loudnessLoop(input: StereoBuffer, options: MasterOptions): StereoBuffer {
  const { targetLufs, ceilingDbtp } = options;
  const key = truePeakKey(input);
  const allowedPeakDb = ceilingDbtp - TRUE_PEAK_MARGIN_DB;
  let limiterCeilingDb = allowedPeakDb - TRUE_PEAK_MARGIN_DB;
  let gainDb = targetLufs - measureLoudness(input).integratedLufs;
  let previous: { gainDb: number; lufs: number } | null = null;
  let reached = { lufs: Number.NaN, peak: Number.NaN };
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const output = limit(input, key, {
      gain: dbToAmplitude(gainDb),
      ceiling: dbToAmplitude(limiterCeilingDb),
    });
    reached = { lufs: measureLoudness(output).integratedLufs, peak: truePeakDbtp(output) };
    const peakOver = reached.peak - allowedPeakDb;
    if (Math.abs(reached.lufs - targetLufs) <= LOUDNESS_TOLERANCE_LU && peakOver <= 0) {
      return output;
    }
    const current = { gainDb, lufs: reached.lufs };
    gainDb += (targetLufs - reached.lufs) / slopeBetween(previous, current);
    previous = current;
    if (peakOver > 0) {
      limiterCeilingDb -= peakOver + TRUE_PEAK_MARGIN_DB;
      // A new ceiling changes what a dB of gain buys, so the last slope no longer holds.
      previous = null;
    }
  }
  throw new RangeError(
    `the master reached ${String(reached.lufs)} LUFS at ${String(reached.peak)} dBTP after ${String(MAX_PASSES)} passes: it cannot hold ${String(targetLufs)} LUFS ±${String(LOUDNESS_TOLERANCE_LU)} under ${String(ceilingDbtp)} dBTP`
  );
}

/**
 * The master chain: a 25 Hz high-pass, the mix brought to a reference
 * loudness, a glue compressor, an oversampled soft clip, then a true-peak
 * lookahead limiter whose input gain a loudness loop sets to land the target
 * under the ceiling. Every stage is aligned with its input, so the master adds
 * no latency to any onset. Dither is not applied here: it is added where the
 * master is written as 24-bit PCM.
 */
export function masterChain(mix: StereoBuffer, options: MasterOptions): StereoBuffer {
  const targetLufs = requireFinite('targetLufs', options.targetLufs);
  const ceilingDbtp = requireFinite('ceilingDbtp', options.ceilingDbtp);
  const filtered = subsonicHighPass(mix);
  const mixLufs = measureLoudness(filtered).integratedLufs;
  if (!Number.isFinite(mixLufs)) {
    throw new RangeError(
      'the mix has no measurable loudness: it is silent, or shorter than one 400 ms loudness block'
    );
  }
  const glued = compress(scaled(filtered, dbToAmplitude(REFERENCE_LUFS - mixLufs)), GLUE);
  const clipped = softClip(glued, SOFT_CLIP_HEADROOM * samplePeak(glued));
  return loudnessLoop(clipped, { targetLufs, ceilingDbtp });
}
