import { z } from 'zod';

import { exp2 } from '../../../dmath/dmath.js';
import { SAMPLE_RATE } from '../../../time/grid.js';
import { pinkNoise, svf, whiteNoise } from '../../dsp/index.js';
import { defineInstrument } from '../instrument.js';
import {
  add,
  anchoredAtStart,
  beatsToSamples,
  gate,
  multiply,
  secondsToSamples,
} from '../voice.js';

import { bedBeatsSchema } from './bed.js';
import { burst } from './burst.js';
import { decorrelated, normalized, scaled, scattered, underEnvelope } from './layer.js';

import type { SvfOptions } from '../../dsp/index.js';
import type { Instrument } from '../instrument.js';
import type { Grain } from './layer.js';

const params = z.object({
  beats: bedBeatsSchema(4),
  /** Seconds the fire takes to swell to full. */
  attack: z.number().min(0).max(30).default(1.5),
  /** Seconds it takes to die away, ending with the sound. */
  release: z.number().min(0).max(30).default(0.6),
  /** Crackles per second. */
  crackle: z.number().min(0).max(60).default(12),
});

/** The roar: pink noise low-passed at 420 Hz. */
const ROAR: SvfOptions = { mode: 'lowpass', cutoff: 420, resonance: 0.15 };
/** The roar's turbulence: its level wanders between 0.6 and 1, slower than 2.5 Hz. */
const TURBULENCE = { cutoff: 2.5, floor: 0.6 };
/** The hiss of burning, faint, above 3 kHz. */
const HISS: SvfOptions = { mode: 'highpass', cutoff: 3000, resonance: 0 };
const HISS_LEVEL = 0.03;
/**
 * A crackle: a burst of 2 to 8 ms, high-passed from 1.5 kHz up to two octaves
 * above, at a drawn level and place, lasting no more than 12 ms.
 */
const CRACKLE = { length: 0.012, shortest: 0.002, longer: 0.006, lowestHz: 1500, octaves: 2 };

/** The roar's level at every sample: slow wandering between the floor and full. */
function turbulence(samples: number, rand: () => number): Float32Array {
  const wander = normalized(
    svf(whiteNoise(samples, rand), { mode: 'lowpass', cutoff: TURBULENCE.cutoff, resonance: 0 })
  );
  return wander.map((value) => TURBULENCE.floor + (1 - TURBULENCE.floor) * (0.5 + 0.5 * value));
}

/** One crackle, drawn from `rand`: at a drawn sample, band, length, level and place. */
function crackleGrain(samples: number, rand: () => number): Grain {
  const at = Math.floor(rand() * samples);
  const t60 = CRACKLE.shortest + CRACKLE.longer * rand();
  const cutoff = CRACKLE.lowestHz * exp2(CRACKLE.octaves * rand());
  const loudness = rand();
  const signal = burst(
    Math.min(secondsToSamples(CRACKLE.length), samples - at),
    {
      t60,
      filter: { mode: 'highpass', cutoff, resonance: 0.2 },
      level: 0.2 + 0.6 * loudness * loudness,
    },
    rand
  );
  return { at, signal, pan: 2 * rand() - 1 };
}

/** A fire's roar of any length: turbulent low noise and a faint hiss in each channel, crackling, swelling in and dying away. */
export const fireRoar: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: false,
  render({ beats, attack, release, crackle }, { rand, framesPerBeat }) {
    const samples = beatsToSamples(beats, framesPerBeat);
    const wandering = turbulence(samples, rand);
    const bed = decorrelated(() =>
      add(
        multiply(svf(pinkNoise(samples, rand), ROAR), wandering),
        scaled(svf(whiteNoise(samples, rand), HISS), HISS_LEVEL)
      )
    );
    const count = Math.round((crackle * samples) / SAMPLE_RATE);
    const crackles = scattered(
      Array.from({ length: count }, () => crackleGrain(samples, rand)),
      samples
    );
    const swell = gate({
      samples,
      attack: secondsToSamples(attack),
      release: secondsToSamples(release),
    });
    return anchoredAtStart(
      underEnvelope(
        { left: add(bed.left, crackles.left), right: add(bed.right, crackles.right) },
        swell
      )
    );
  },
});
