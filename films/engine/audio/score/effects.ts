import { SAMPLE_RATE } from '../../time/grid.js';
import { fdnReverb, feedbackDelay, sampleAt, saturate, svf } from '../dsp/index.js';

import type { StereoBuffer } from '../dsp/index.js';
import type { ResolvedEffect } from './define-score.js';

/** Samples of fade at each edge of a stuttered slice, so a repeat does not click: 1 ms. */
export const STUTTER_FADE = Math.round(0.001 * SAMPLE_RATE);

type Stutter = Extract<ResolvedEffect, { kind: 'stutter' }>;
type TapeStop = Extract<ResolvedEffect, { kind: 'tapeStop' }>;

function eachChannel(
  buffer: StereoBuffer,
  process: (channel: Float32Array) => Float32Array
): StereoBuffer {
  return { left: process(buffer.left), right: process(buffer.right) };
}

/** The dry signal with the wet added at the mix level. */
function withWet(dry: Float32Array, wet: Float32Array, mix: number): Float32Array {
  return dry.map((sample, index) => sample + mix * sampleAt(wet, index));
}

/** A linear ramp over `fade` samples: 0 at distance 0, 1 from `fade` on; with no fade, always 1. */
function edgeGain(distance: number, fade: number): number {
  return distance >= fade ? 1 : distance / fade;
}

/**
 * The slice from the cue repeated until `repeats` slices have played, then the
 * signal resuming where they end. The slice's own first sample is untouched, so
 * the cue's onset survives; every other slice edge, and the resumption, fades.
 */
function stutter(channel: Float32Array, { from, sliceSamples, repeats }: Stutter): Float32Array {
  const output = Float32Array.from(channel);
  const fade = Math.min(STUTTER_FADE, Math.floor(sliceSamples / 2));
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (let offset = 0; offset < sliceSamples; offset++) {
      const fadeIn = repeat === 0 ? 1 : edgeGain(offset, fade);
      const gain = fadeIn * edgeGain(sliceSamples - offset, fade);
      output[from + repeat * sliceSamples + offset] = sampleAt(channel, from + offset) * gain;
    }
  }
  const end = from + repeats * sliceSamples;
  for (let offset = 0; offset < STUTTER_FADE && end + offset < channel.length; offset++) {
    output[end + offset] = sampleAt(channel, end + offset) * edgeGain(offset, STUTTER_FADE);
  }
  return output;
}

/** The sample at an index, or silence before the signal's start and past its end. */
function sampleOrSilence(channel: Float32Array, index: number): number {
  return channel[index] ?? 0;
}

/** The signal at a fractional position by four-point Catmull-Rom interpolation. */
function interpolated(channel: Float32Array, position: number): number {
  const index = Math.floor(position);
  const t = position - index;
  const before = sampleOrSilence(channel, index - 1);
  const at = sampleOrSilence(channel, index);
  const after = sampleOrSilence(channel, index + 1);
  const beyond = sampleOrSilence(channel, index + 2);
  const slope = 0.5 * (after - before);
  const curve = before - 2.5 * at + 2 * after - 0.5 * beyond;
  const cubic = 0.5 * (beyond - before) + 1.5 * (at - after);
  return ((cubic * t + curve) * t + slope) * t + at;
}

/** Hz: the tape stop's low-pass corner at full speed, falling in proportion to the speed. */
const TAPE_STOP_TOP_HZ = 20_000;
/** q = 1/√2 in the filter's resonance terms: flat to the corner, so full speed sounds unfiltered. */
const BUTTERWORTH_RESONANCE = 1 - Math.SQRT1_2;
/**
 * Samples of the signal before the cue the low-pass runs over first, so its
 * state has settled on the signal and the stop starts without a step: 1 ms.
 */
const TAPE_STOP_LEAD = Math.round(0.001 * SAMPLE_RATE);

/**
 * The signal read from the cue at a speed falling from 1 to 0 as (1 − u)² over
 * the stop, u its progress, through a low-pass whose corner falls with the
 * speed, its level falling with the speed as a tape's does. The read position
 * is the speed's integral, so the pitch falls smoothly with it.
 */
function tapeStop(channel: Float32Array, { from, samples }: TapeStop): Float32Array {
  const lead = Math.min(from, TAPE_STOP_LEAD);
  const read = new Float32Array(lead + samples);
  read.set(channel.subarray(from - lead, from));
  const cutoff = new Float32Array(lead + samples).fill(TAPE_STOP_TOP_HZ);
  const speeds = new Float32Array(samples);
  for (let step = 0; step < samples; step++) {
    const remaining = 1 - step / samples;
    const speed = remaining * remaining;
    const travelled = (samples * (1 - speed * remaining)) / 3;
    read[lead + step] = interpolated(channel, from + travelled);
    cutoff[lead + step] = TAPE_STOP_TOP_HZ * speed;
    speeds[step] = speed;
  }
  const filtered = svf(read, { mode: 'lowpass', cutoff, resonance: BUTTERWORTH_RESONANCE });
  const output = Float32Array.from(channel);
  for (let step = 0; step < samples; step++) {
    output[from + step] = sampleAt(filtered, lead + step) * sampleAt(speeds, step);
  }
  return output;
}

/** A bus effect over a whole bus; the output is as long as the input. */
export function applyEffect(buffer: StereoBuffer, effect: ResolvedEffect): StereoBuffer {
  switch (effect.kind) {
    case 'reverb': {
      const wet = fdnReverb(buffer, { rt60: effect.rt60, damping: effect.damping });
      return {
        left: withWet(buffer.left, wet.left, effect.mix),
        right: withWet(buffer.right, wet.right, effect.mix),
      };
    }
    case 'delay': {
      const options = { time: effect.samples, feedback: effect.feedback };
      return eachChannel(buffer, (channel) =>
        withWet(channel, feedbackDelay(channel, options), effect.mix)
      );
    }
    case 'saturation': {
      // Divided by the drive, so a quiet signal keeps its level and only peaks round off.
      return eachChannel(buffer, (channel) =>
        saturate(channel, effect.drive).map((sample) => sample / effect.drive)
      );
    }
    case 'filter': {
      const { mode, cutoff, resonance } = effect;
      return eachChannel(buffer, (channel) => svf(channel, { mode, cutoff, resonance }));
    }
    case 'stutter': {
      return eachChannel(buffer, (channel) => stutter(channel, effect));
    }
    case 'tapeStop': {
      return eachChannel(buffer, (channel) => tapeStop(channel, effect));
    }
  }
}
