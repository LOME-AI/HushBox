import { z } from 'zod';

import { exp2 } from '../../../dmath/dmath.js';
import { defineInstrument } from '../instrument.js';
import { add, anchoredAtStart, secondsToSamples } from '../voice.js';

import { burst, bursts } from './burst.js';
import { scattered } from './layer.js';

import type { Instrument } from '../instrument.js';
import type { Burst } from './burst.js';
import type { Grain } from './layer.js';

const params = z.object({
  /** Hz the breaking body rings around. */
  toneHz: z.number().min(500).max(5000).default(1700),
  /** Seconds for the ring to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.03).max(0.8).default(0.18),
});

/** The break itself: a burst of a few milliseconds above 3 kHz. */
const BREAK: Burst = {
  t60: 0.005,
  filter: { mode: 'highpass', cutoff: 3000, resonance: 0 },
  level: 0.8,
};
const RING_RESONANCE = 0.7;
/**
 * The splinters after the break: at least `fewest` and under `fewest + more`,
 * each somewhere in the first `spread` of the sound, in its own band and place.
 */
const SPLINTERS = { fewest: 3, more: 4, spread: 0.5 } as const;
/** A splinter's band: from 1 kHz up to 2.5 octaves above. */
const SPLINTER_LOWEST_HZ = 1000;
const SPLINTER_OCTAVES = 2.5;
const SPLINTER_RESONANCE = 0.4;

/** One splinter, drawn from `rand`: a tiny band-passed burst at a drawn sample and place. */
function splinter(samples: number, rand: () => number): Grain {
  const at = Math.floor(rand() * samples * SPLINTERS.spread);
  const spec: Burst = {
    t60: 0.002 + 0.004 * rand(),
    filter: {
      mode: 'bandpass',
      cutoff: SPLINTER_LOWEST_HZ * exp2(SPLINTER_OCTAVES * rand()),
      resonance: SPLINTER_RESONANCE,
    },
    level: 0.3 + 0.4 * rand(),
  };
  return { at, signal: burst(samples - at, spec, rand), pan: 2 * rand() - 1 };
}

/** A brittle break: a sharp burst, a resonant ring, and splinters scattered across the field. */
export const crack: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ toneHz, decay }, { rand }) {
    const samples = secondsToSamples(decay);
    const ring: Burst = {
      t60: decay,
      filter: { mode: 'bandpass', cutoff: toneHz, resonance: RING_RESONANCE },
      level: 1,
    };
    const core = bursts(samples, [BREAK, ring], rand);
    const count = SPLINTERS.fewest + Math.floor(rand() * SPLINTERS.more);
    const splinters = scattered(
      Array.from({ length: count }, () => splinter(samples, rand)),
      samples
    );
    return anchoredAtStart({ left: add(core, splinters.left), right: add(core, splinters.right) });
  },
});
