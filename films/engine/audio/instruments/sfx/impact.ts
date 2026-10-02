import { z } from 'zod';

import { exponentialDecay, exponentialRamp, saturate, sine, svf } from '../../dsp/index.js';
import { membrane } from '../drum.js';
import { defineInstrument } from '../instrument.js';
import { add, anchoredAtStart, multiply, secondsToSamples } from '../voice.js';

import { burst } from './burst.js';
import { scaled } from './layer.js';
import { METAL_MODES, modalRing } from './modes.js';

import type { SvfOptions } from '../../dsp/index.js';
import type { Instrument } from '../instrument.js';

const params = z.object({
  /** Seconds for the sub to fall 60 dB, which is also the sound's length. */
  decay: z.number().min(0.3).max(6).default(2),
  /** Hz the sub drops onto. */
  subHz: z.number().min(20).max(60).default(32),
  /** The saturator's drive over the body: more is a harder, denser hit. */
  drive: z.number().min(0.5).max(8).default(2),
  /** How loud the metal rings: 0 leaves it out. */
  metal: z.number().min(0).max(1).default(0.5),
});

/** The sub drops from three times its frequency, covering all but a thousandth of the fall in 0.8 s. */
const SUB = { startRatio: 3, pitchT60: 0.8, level: 0.9 };
/** The thud: a kick-like membrane falling from 160 to 55 Hz. */
const THUD = { startHz: 160, endHz: 55, pitchT60: 0.12, t60: 0.5, level: 0.7 };
/** The debris: struck noise whose low-pass sweeps from 5 kHz down to 200 Hz over 0.3 s. */
const DEBRIS = { fromHz: 5000, toHz: 200, sweep: 0.3, t60: 0.35, level: 0.6 };
/** The metal rings over 900 Hz. */
const METAL_HZ = 900;
const METAL = { t60: 1.5, level: 0.35, detune: 0.004 };
const METAL_HIGHPASS: SvfOptions = { mode: 'highpass', cutoff: 1200, resonance: 0 };

/** The debris filter's cutoff at every sample: the sweep down, then held at its floor. */
function debrisCutoff(samples: number): Float32Array {
  const cutoff = new Float32Array(samples).fill(DEBRIS.toHz);
  cutoff.set(
    exponentialRamp({
      from: DEBRIS.fromHz,
      to: DEBRIS.toHz,
      samples: Math.min(samples, secondsToSamples(DEBRIS.sweep)),
    })
  );
  return cutoff;
}

/**
 * A trailer impact: a sub drop, a thud and struck debris saturated together in
 * the middle of the field, and a metal ring detuned apart in each channel.
 */
export const impact: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ decay, subHz, drive, metal }, { rand }) {
    const samples = secondsToSamples(decay);
    const subFrequency = exponentialDecay({ samples, t60: SUB.pitchT60 }).map(
      (remaining) => subHz * (1 + (SUB.startRatio - 1) * remaining)
    );
    const sub = multiply(
      sine({ frequency: subFrequency, samples }),
      exponentialDecay({ samples, t60: decay })
    );
    const thud = membrane({
      samples,
      startHz: THUD.startHz,
      endHz: THUD.endHz,
      pitchT60: THUD.pitchT60,
      t60: Math.min(THUD.t60, decay),
    });
    const debris = burst(
      samples,
      {
        t60: Math.min(DEBRIS.t60, decay),
        filter: { mode: 'lowpass', cutoff: debrisCutoff(samples), resonance: 0 },
        level: DEBRIS.level,
      },
      rand
    );
    const body = saturate(
      add(add(scaled(sub, SUB.level), scaled(thud, THUD.level)), debris),
      drive
    );
    const ring = (): Float32Array => {
      const hertz = METAL_HZ * (1 + METAL.detune * (2 * rand() - 1));
      const modes = modalRing({
        hertz,
        samples,
        t60: Math.min(METAL.t60, decay),
        modes: METAL_MODES,
      });
      return scaled(svf(modes, METAL_HIGHPASS), metal * METAL.level);
    };
    return anchoredAtStart({ left: add(body, ring()), right: add(body, ring()) });
  },
});
