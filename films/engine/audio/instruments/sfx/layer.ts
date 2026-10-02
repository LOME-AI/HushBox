import { createStereo, mixInto, sampleAt, sine } from '../../dsp/index.js';
import { freeRunning, multiply } from '../voice.js';

import type { OscillatorOptions, StereoBuffer } from '../../dsp/index.js';

/** Every sample multiplied by `level`. */
export function scaled(signal: Float32Array, level: number): Float32Array {
  return signal.map((sample) => sample * level);
}

/** `signal` starting at sample `at` of `samples` samples of silence; whatever falls past the end is dropped. */
export function placedAt(signal: Float32Array, at: number, samples: number): Float32Array {
  const output = new Float32Array(samples);
  output.set(signal.subarray(0, Math.max(0, samples - at)), Math.min(at, samples));
  return output;
}

/** The signal scaled so its loudest magnitude is 1; a silent signal stays silent. */
export function normalized(signal: Float32Array): Float32Array {
  let peak = 0;
  for (const sample of signal) {
    peak = Math.max(peak, Math.abs(sample));
  }
  return peak === 0 ? signal : scaled(signal, 1 / peak);
}

/** A quarter of a cycle: the phase of a sine's crest. */
const AT_CREST = (): number => 0.25;

/**
 * A sine that starts within one sample's phase step of its crest, not at 0, so
 * a struck tone is heard from its first sample: it is rendered from a quarter
 * cycle of its first frequency earlier, and that lead is dropped.
 */
export function crestSine(options: OscillatorOptions): Float32Array {
  const { frequency } = options;
  const leadHz = typeof frequency === 'number' ? frequency : sampleAt(frequency, 0);
  return freeRunning(sine, { ...options, leadHz }, AT_CREST);
}

/** Two channels, each rendered by its own call, so a noise source gives each its own noise. */
export function decorrelated(render: () => Float32Array): StereoBuffer {
  return { left: render(), right: render() };
}

/** A short mono sound placed at a sample and a place in the field. */
export interface Grain {
  at: number;
  signal: Float32Array;
  /** In [−1, 1], by the constant-power law. */
  pan: number;
}

/** Grains mixed into `samples` samples of stereo silence; whatever falls past the end is dropped. */
export function scattered(grains: Iterable<Grain>, samples: number): StereoBuffer {
  const output = createStereo(samples);
  for (const { at, signal, pan } of grains) {
    mixInto(output, signal, { atSample: at, gain: 1, pan });
  }
  return output;
}

/** Both channels multiplied by one envelope. */
export function underEnvelope(buffer: StereoBuffer, envelope: Float32Array): StereoBuffer {
  return { left: multiply(buffer.left, envelope), right: multiply(buffer.right, envelope) };
}
