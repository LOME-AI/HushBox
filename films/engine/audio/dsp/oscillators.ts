import { sin } from '../../dmath/dmath.js';
import { SAMPLE_RATE } from '../../time/grid.js';

import { AUDIO_FREQUENCY, requireSampleCount } from './bounds.js';
import { controlInRange, requireControl } from './buffer.js';

import type { Control } from './buffer.js';

export interface OscillatorOptions {
  /** Hz, in [0, SAMPLE_RATE / 2): constant, or one value per sample. */
  frequency: Control;
  samples: number;
}

/** A waveform's value at a phase in cycles, given the phase step per sample. */
type Shape = (phase: number, increment: number) => number;

const TWO_PI = 2 * Math.PI;

/**
 * Runs a shape over a phase counted in cycles and wrapped to [0, 1), so `sin`
 * receives an argument in [0, 2π) however long the output: an unwrapped 2π·f·t
 * leaves the range dmath's `sin` accepts once f·t passes 262,144 cycles.
 */
function render(options: OscillatorOptions, shape: Shape): Float32Array {
  const { frequency, samples } = options;
  requireSampleCount('samples', samples);
  requireControl('frequency', frequency, samples, AUDIO_FREQUENCY);
  const output = new Float32Array(samples);
  let phase = 0;
  for (let index = 0; index < samples; index++) {
    const increment = controlInRange('frequency', frequency, index, AUDIO_FREQUENCY) / SAMPLE_RATE;
    output[index] = shape(phase, increment);
    phase += increment;
    if (phase >= 1) {
      phase -= 1;
    }
  }
  return output;
}

/**
 * The two-sample PolyBLEP residual of a rising step of height 2 at phase 0: the
 * band-limited step less the sampled one, nonzero within one sample of the step.
 */
function polyBlep(phase: number, increment: number): number {
  if (phase < increment) {
    const x = phase / increment;
    return x + x - x * x - 1;
  }
  if (phase > 1 - increment) {
    const x = (phase - 1) / increment;
    return x * x + x + x + 1;
  }
  return 0;
}

/** The PolyBLAMP residual of a unit change of slope per sample at phase 0: PolyBLEP integrated. */
function polyBlamp(phase: number, increment: number): number {
  if (phase < increment) {
    const x = 1 - phase / increment;
    return (x * x * x) / 6;
  }
  if (phase > 1 - increment) {
    const x = 1 + (phase - 1) / increment;
    return (x * x * x) / 6;
  }
  return 0;
}

/** The phase half a cycle on, where the square falls and the triangle peaks. */
function halfCycleOn(phase: number): number {
  return phase < 0.5 ? phase + 0.5 : phase - 0.5;
}

/** A sine starting at phase 0, amplitude 1. */
export function sine(options: OscillatorOptions): Float32Array {
  return render(options, (phase) => sin(TWO_PI * phase));
}

/** A rising saw from −1 to 1, band-limited by PolyBLEP at its reset. */
export function saw(options: OscillatorOptions): Float32Array {
  return render(options, (phase, increment) => 2 * phase - 1 - polyBlep(phase, increment));
}

/** A square at 1 for the first half cycle and −1 for the second, band-limited by PolyBLEP. */
export function square(options: OscillatorOptions): Float32Array {
  return render(
    options,
    (phase, increment) =>
      (phase < 0.5 ? 1 : -1) + polyBlep(phase, increment) - polyBlep(halfCycleOn(phase), increment)
  );
}

/**
 * A triangle from −1 at phase 0 to 1 at phase ½, band-limited by PolyBLAMP at
 * both corners, where its slope turns by 8 per cycle.
 */
export function triangle(options: OscillatorOptions): Float32Array {
  return render(options, (phase, increment) => {
    const corner = polyBlamp(phase, increment) - polyBlamp(halfCycleOn(phase), increment);
    return (phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase) + 8 * increment * corner;
  });
}
