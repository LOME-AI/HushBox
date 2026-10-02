import { cos, exp2 } from '../../../dmath/dmath.js';
import { exponentialRamp, sine } from '../../dsp/index.js';
import { excite } from '../drum.js';
import { add, multiply } from '../voice.js';

import { decorrelated, scaled } from './layer.js';

import type { FilterMode, StereoBuffer } from '../../dsp/index.js';

/** The noise's filter falls from 12 kHz to 200 Hz. */
const NOISE = { highHz: 12_000, lowHz: 200, resonance: 0.3 };
/** The tone falls from 1.6 kHz. */
const TONE = { topHz: 1600, level: 0.25 };
/** The Shepard layer's octave-spaced partials span eight octaves up from 40 Hz. */
const SHEPARD = { lowestHz: 40, octaves: 8 };

/**
 * A sweep falling under `envelope` from a strike: in each channel its own struck
 * noise, its `mode` filter falling from 12 kHz to 200 Hz, over one tone falling
 * `octaves` from 1.6 kHz. The strike makes the first sample heard whatever the
 * seed; the tone starts at phase 0 and adds nothing there.
 */
export function fallingSweep(
  options: { envelope: Float32Array; octaves: number; mode: FilterMode },
  rand: () => number
): StereoBuffer {
  const { envelope, octaves, mode } = options;
  const samples = envelope.length;
  const cutoff = exponentialRamp({ from: NOISE.highHz, to: NOISE.lowHz, samples });
  const glide = exponentialRamp({ from: TONE.topHz, to: TONE.topHz / exp2(octaves), samples });
  const tone = scaled(multiply(sine({ frequency: glide, samples }), envelope), TONE.level);
  const noise = decorrelated(() =>
    excite({ envelope, filter: { mode, cutoff, resonance: NOISE.resonance } }, rand)
  );
  return { left: add(noise.left, tone), right: add(noise.right, tone) };
}

/** `x` wrapped into [0, span). */
function wrap(x: number, span: number): number {
  return ((x % span) + span) % span;
}

/**
 * A Shepard–Risset glissando falling `octaves` over its length: octave-spaced
 * sines whose places in log frequency fall together, each wrapping from the
 * bottom of the span to the top, weighted by a raised cosine over the span that
 * is zero where a partial wraps, so it re-enters silently. The squares of the
 * partials' weights always sum to three-eighths of their count, so the layer's
 * power holds as they move. Every partial starts at phase 0.
 */
export function shepardFall(samples: number, octaves: number): Float32Array {
  let sum: Float32Array = new Float32Array(samples);
  for (let partial = 0; partial < SHEPARD.octaves; partial++) {
    const place = new Float32Array(samples).map((_zero, index) =>
      wrap(partial - (octaves * index) / samples, SHEPARD.octaves)
    );
    const frequency = place.map((octave) => SHEPARD.lowestHz * exp2(octave));
    const weight = place.map((octave) => 0.5 - 0.5 * cos((2 * Math.PI * octave) / SHEPARD.octaves));
    sum = add(sum, multiply(sine({ frequency, samples }), weight));
  }
  return scaled(sum, 2 / SHEPARD.octaves);
}
