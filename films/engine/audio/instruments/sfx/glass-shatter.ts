import { z } from 'zod';

import { exp2 } from '../../../dmath/dmath.js';
import { defineInstrument } from '../instrument.js';
import { add, anchoredAtStart, secondsToSamples } from '../voice.js';

import { bursts } from './burst.js';
import { decorrelated, scaled, scattered } from './layer.js';
import { modalRing } from './modes.js';

import type { SvfOptions } from '../../dsp/index.js';
import type { Instrument } from '../instrument.js';
import type { Burst } from './burst.js';
import type { Grain } from './layer.js';
import type { Mode } from './modes.js';

const params = z.object({
  /** Seconds for the crunch to fall 60 dB and the shards to finish falling, which is also the sound's length. */
  decay: z.number().min(0.3).max(4).default(1.4),
  /** How many shards ring after the break. */
  shards: z.int().min(8).max(200).default(48),
});

/** The break: a bright burst of about a tenth of a second above 1.8 kHz. */
const BREAK: Burst = {
  t60: 0.12,
  filter: { mode: 'highpass', cutoff: 1800, resonance: 0.1 },
  level: 1,
};
/** The crunch under the shards: noise band-passed around 4.2 kHz, dying in a share of the decay. */
const CRUNCH = { decayShare: 0.35, level: 0.35 };
const CRUNCH_FILTER: SvfOptions = { mode: 'bandpass', cutoff: 4200, resonance: 0.2 };
/**
 * The shards: each lands in the first `spread` of the sound, bunched towards the
 * break, rings from 2.5 kHz up to 2.1 octaves above for 30 to 230 ms, and is
 * quieter the later it lands.
 */
const SHARD = {
  spread: 0.7,
  lowestHz: 2500,
  octaves: 2.1,
  shortest: 0.03,
  longer: 0.2,
  level: 0.5,
};
/** A shard's inharmonic partials, those of a small struck bar. */
const SHARD_MODES: readonly Mode[] = [
  { ratio: 1, level: 1, decayShare: 1 },
  { ratio: 2.756, level: 0.4, decayShare: 0.5 },
  { ratio: 5.404, level: 0.2, decayShare: 0.3 },
];

/** One shard, drawn from `rand`: a short ring at a drawn sample, pitch, length, level and place. */
function shard(samples: number, rand: () => number): Grain {
  const landing = rand();
  const at = Math.floor(landing * landing * samples * SHARD.spread);
  const hertz = SHARD.lowestHz * exp2(SHARD.octaves * rand());
  const t60 = SHARD.shortest + SHARD.longer * rand();
  const level = SHARD.level * (0.3 + 0.7 * rand()) * (1 - at / samples);
  const ring = modalRing({
    hertz,
    samples: Math.min(secondsToSamples(t60), samples - at),
    t60,
    modes: SHARD_MODES,
  });
  return { at, signal: scaled(ring, level), pan: 2 * rand() - 1 };
}

/** Breaking glass: a bright burst and a crunch, then resonant shards falling across the field. */
export const glassShatter: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ decay, shards }, { rand }) {
    const samples = secondsToSamples(decay);
    const crunch: Burst = {
      t60: decay * CRUNCH.decayShare,
      filter: CRUNCH_FILTER,
      level: CRUNCH.level,
    };
    const breaking = decorrelated(() => bursts(samples, [BREAK, crunch], rand));
    const falling = scattered(
      Array.from({ length: shards }, () => shard(samples, rand)),
      samples
    );
    return anchoredAtStart({
      left: add(breaking.left, falling.left),
      right: add(breaking.right, falling.right),
    });
  },
});
