import { z } from 'zod';

import { exponentialRamp, sampleAt, sine, svf, whiteNoise } from '../../dsp/index.js';
import { defineInstrument } from '../instrument.js';
import { add, anchoredAtStart, gate, multiply, secondsToSamples } from '../voice.js';

import { normalized, scaled } from './layer.js';

import type { Instrument } from '../instrument.js';

const params = z.object({
  /** Hz the screech peaks at. */
  toneHz: z.number().min(300).max(3000).default(1300),
  /** Seconds from its onset to its end, which is also the sound's length. */
  seconds: z.number().min(0.2).max(4).default(0.9),
});

/** The pitch rises from 0.6 of its tone to the tone in the first 15%, then sags to 0.75 of it. */
const ARC = { from: 0.6, riseShare: 0.15, to: 0.75 };
/** A wobble of up to 3% in the pitch, slower than 14 Hz. */
const WOBBLE = { cutoff: 14, depth: 0.03 };
/**
 * The frequency-modulation operator: the carrier's instantaneous frequency swings
 * by 85% at 0.29 of the pitch, an inharmonic ratio whose sidebands make a harsh
 * screech rather than a note.
 */
const OPERATOR = { ratio: 0.29, depth: 0.85, level: 0.5 };
/** A high-pass at half the pitch drops the sidebands the modulation folds down near 0 Hz, which would rumble. */
const FOLD_HIGHPASS = { share: 0.5, resonance: 0 };
/** The right channel's operator runs this much sharp, so the two beat against each other. */
const DETUNE = 1.009;
/** Wind through the screech: noise band-passed at twice the pitch. */
const WIND = { ratio: 2, resonance: 0.6, level: 0.4 };
const ATTACK = 0.02;
const RELEASE_SHARE = 0.35;

/** The pitch at every sample: the rise, then the sag. */
function arc(toneHz: number, samples: number): Float32Array {
  const rise = Math.round(samples * ARC.riseShare);
  const pitch = new Float32Array(samples);
  pitch.set(exponentialRamp({ from: toneHz * ARC.from, to: toneHz, samples: rise }));
  pitch.set(exponentialRamp({ from: toneHz, to: toneHz * ARC.to, samples: samples - rise }), rise);
  return pitch;
}

/** One frequency-modulation operator: a sine whose frequency the modulator swings about the pitch, high-passed. */
function operator(pitch: Float32Array, detune: number): Float32Array {
  const modulator = sine({
    frequency: pitch.map((hertz) => hertz * detune * OPERATOR.ratio),
    samples: pitch.length,
  });
  const frequency = pitch.map(
    (hertz, index) => hertz * detune * (1 + OPERATOR.depth * sampleAt(modulator, index))
  );
  return svf(sine({ frequency, samples: pitch.length }), {
    mode: 'highpass',
    cutoff: pitch.map((hertz) => hertz * FOLD_HIGHPASS.share),
    resonance: FOLD_HIGHPASS.resonance,
  });
}

/**
 * A non-vocal screech: two frequency-modulation operators and band-passed wind
 * riding one pitch arc. Built from FM operators and filtered noise only, with
 * no formant or vocal-tract shaping: the film carries no human voice.
 */
export const shriek: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ toneHz, seconds }, { rand }) {
    const samples = secondsToSamples(seconds);
    const wobble = normalized(
      svf(whiteNoise(samples, rand), { mode: 'lowpass', cutoff: WOBBLE.cutoff, resonance: 0 })
    );
    const pitch = multiply(
      arc(toneHz, samples),
      wobble.map((value) => 1 + WOBBLE.depth * value)
    );
    const wind = (): Float32Array =>
      scaled(
        svf(whiteNoise(samples, rand), {
          mode: 'bandpass',
          cutoff: pitch.map((hertz) => hertz * WIND.ratio),
          resonance: WIND.resonance,
        }),
        WIND.level
      );
    const envelope = gate({
      samples,
      attack: secondsToSamples(ATTACK),
      release: Math.round(samples * RELEASE_SHARE),
    });
    const channel = (detune: number): Float32Array =>
      multiply(add(scaled(operator(pitch, detune), OPERATOR.level), wind()), envelope);
    return anchoredAtStart({ left: channel(1), right: channel(DETUNE) });
  },
});
