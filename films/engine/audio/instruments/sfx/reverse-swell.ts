import { z } from 'zod';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { svf } from '../../dsp/index.js';
import { defineInstrument } from '../instrument.js';
import { beatsSchema } from '../note-params.js';
import { add, beatsToSamples } from '../voice.js';

import { anchoredAtEnd, reversed } from './anchor.js';
import { burst } from './burst.js';
import { decorrelated, scaled, underEnvelope } from './layer.js';
import { METAL_MODES, modalRing } from './modes.js';

import type { SvfOptions } from '../../dsp/index.js';
import type { Instrument } from '../instrument.js';

const params = z.object({
  beats: beatsSchema(2),
});

/** The crash's wash: struck noise above 3.5 kHz. */
const WASH_HIGHPASS: SvfOptions = { mode: 'highpass', cutoff: 3500, resonance: 0.1 };
/** The crash's body: metal ringing over 530 Hz, high-passed at 2 kHz, each channel detuned apart by up to 0.4%. */
const BODY = { hertz: 530, level: 0.3, detune: 0.004 };
const BODY_HIGHPASS: SvfOptions = { mode: 'highpass', cutoff: 2000, resonance: 0 };

/** The fade-in's level at every sample of the time-reversed render: the square of the time left. */
function fadeOut(samples: number): Float32Array {
  return new Float32Array(samples).map((_zero, index) => {
    const left = 1 - index / samples;
    return left * left;
  });
}

/**
 * A reverse swell: a cymbal crash falling 60 dB over the sound's length, played
 * backwards under a fade-in, so it swells into its cue. Its last sample is the
 * crash's strike, heard whatever the seed.
 */
export const reverseSwell: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ beats }, { rand, framesPerBeat }) {
    const samples = beatsToSamples(beats, framesPerBeat);
    const t60 = samples / SAMPLE_RATE;
    const crash = (): Float32Array => {
      const wash = burst(samples, { t60, filter: WASH_HIGHPASS, level: 1 }, rand);
      const hertz = BODY.hertz * (1 + BODY.detune * (2 * rand() - 1));
      const body = svf(modalRing({ hertz, samples, t60, modes: METAL_MODES }), BODY_HIGHPASS);
      return add(wash, scaled(body, BODY.level));
    };
    return anchoredAtEnd(reversed(underEnvelope(decorrelated(crash), fadeOut(samples))));
  },
});
