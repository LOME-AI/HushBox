import { z } from 'zod';

import { exp2, sin } from '../../../dmath/dmath.js';
import { SAMPLE_RATE } from '../../../time/grid.js';
import { createStereo, panGains, sampleAt, svf, whiteNoise } from '../../dsp/index.js';
import { defineInstrument } from '../instrument.js';
import { multiply, secondsToSamples, swing } from '../voice.js';

import { anchoredAt } from './anchor.js';

import type { StereoBuffer } from '../../dsp/index.js';
import type { Instrument } from '../instrument.js';

const params = z.object({
  /** Seconds from the whoosh's first sound to its last, which is also the sound's length. */
  seconds: z.number().min(0.1).max(4).default(0.8),
  /** How far the pitch falls through the pass-by, in semitones. */
  semitones: z.number().min(0).max(12).default(4),
  direction: z.enum(['leftToRight', 'rightToLeft']).default('leftToRight'),
});

/** The air rushes in a band centred on 350 Hz, rising to 3.55 kHz at the pass-by. */
const BAND = { restHz: 350, sweepHz: 3200, resonance: 0.35 };
/** Distance dulls it: a low-pass at 1.5 kHz, opening to 12 kHz at the pass-by. */
const DISTANCE = { farHz: 1500, openHz: 10_500 };
/** The closest approach, in seconds of travel, as a share of the length: how sharply the pass-by peaks and its pitch turns. */
const CLOSEST_SHARE = 0.08;
const SEMITONES_PER_OCTAVE = 12;

/**
 * The source's distance at every sample, in seconds of its travel: it passes
 * closest, `closest` away, halfway through.
 */
function distances(samples: number, closest: number): Float32Array {
  const middle = (samples - 1) / 2;
  return new Float32Array(samples).map((_zero, index) => {
    const time = (index - middle) / SAMPLE_RATE;
    const distanceSquared = closest * closest + time * time;
    return Math.sqrt(distanceSquared);
  });
}

/**
 * How much later than at the pass-by, in samples, the source's sound reaches
 * the listener: its extra distance over the speed of sound. Read through that
 * delay, the pitch ratio falls from 1 + v/c to 1 − v/c, where
 * (1 + v/c) / (1 − v/c) is the fall asked for.
 */
function dopplerDelay(distance: Float32Array, closest: number, semitones: number): Float32Array {
  const ratio = exp2(semitones / SEMITONES_PER_OCTAVE);
  const speed = (ratio - 1) / (ratio + 1);
  return distance.map((far) => SAMPLE_RATE * speed * (far - closest));
}

/** The signal swept across the field by the constant-power law, from one side to the other. */
function panSweep(signal: Float32Array, from: number): StereoBuffer {
  const output = createStereo(signal.length);
  const last = Math.max(signal.length - 1, 1);
  for (const [index, sample] of signal.entries()) {
    const [left, right] = panGains(from * (1 - (2 * index) / last));
    output.left[index] = sample * left;
    output.right[index] = sample * right;
  }
  return output;
}

/**
 * A whoosh: band-passed noise passing by, loudest, brightest and closest in its
 * middle, falling in pitch through the pass-by by Doppler, and sweeping across
 * the field. Its cue lands on the pass-by, halfway through, where both the
 * 1/distance loudness and its taper peak (on the first of the two middle
 * samples when the length is even). The loudest sample of its seeded noise
 * falls near there but moves with the seed, so the cue never follows it.
 */
export const whoosh: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ seconds, semitones, direction }, { rand }) {
    const samples = secondsToSamples(seconds);
    const last = samples - 1;
    const closeness = new Float32Array(samples).map((_zero, index) =>
      sin((Math.PI * index) / last)
    );
    const band = svf(whiteNoise(samples, rand), {
      mode: 'bandpass',
      cutoff: closeness.map((near) => BAND.restHz + BAND.sweepHz * near),
      resonance: BAND.resonance,
    });
    const closest = seconds * CLOSEST_SHARE;
    const distance = distances(samples, closest);
    const passing = svf(swing(band, dopplerDelay(distance, closest, semitones)), {
      mode: 'lowpass',
      cutoff: closeness.map((near) => DISTANCE.farHz + DISTANCE.openHz * near),
      resonance: 0,
    });
    // Loudness falls as 1 / distance, tapered to silence at both ends.
    const loudness = distance.map((far, index) => {
      const near = sampleAt(closeness, index);
      return (closest / far) * near * near;
    });
    return anchoredAt(
      panSweep(multiply(passing, loudness), direction === 'leftToRight' ? -1 : 1),
      Math.floor((samples - 1) / 2)
    );
  },
});
