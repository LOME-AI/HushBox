import { z } from 'zod';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { exponentialDecay, exponentialRamp, svf, whiteNoise } from '../../dsp/index.js';
import { excite, membrane } from '../drum.js';
import { defineInstrument } from '../instrument.js';
import { add, anchoredAtStart, gate, multiply, secondsToSamples } from '../voice.js';

import { decorrelated, normalized, placedAt, scaled } from './layer.js';

import type { Instrument } from '../instrument.js';

const params = z.object({
  /** Seconds from the scrape to the end of the flare's burn, which is also the sound's length. */
  seconds: z.number().min(0.3).max(4).default(1.2),
});

/**
 * The head scraping the strip: struck noise band-passed from 2.2 up to 4.8 kHz
 * over 90 ms, falling 60 dB in 60 ms, its level roughened by grit.
 */
const SCRAPE = { length: 0.09, fromHz: 2200, toHz: 4800, resonance: 0.35, t60: 0.06, level: 0.5 };
/** The grit: noise low-passed at 300 Hz and rectified, over a floor so the scrape never gaps. */
const GRIT = { cutoff: 300, floor: 0.3 };
/**
 * The flare, 50 ms in: noise whose low-pass swells from 500 Hz to 3.5 kHz in
 * 60 ms, settles to 900 Hz over the next 150 ms, and burns there, rising in
 * 20 ms and falling 60 dB by the end.
 */
const FLARE = {
  at: 0.05,
  attack: 0.02,
  fromHz: 500,
  peakHz: 3500,
  swell: 0.06,
  burnHz: 900,
  settle: 0.15,
  resonance: 0.2,
};
/** The ignition's soft thump under the flare. */
const FWUMP = { startHz: 130, endHz: 70, pitchT60: 0.08, t60: 0.25, level: 0.4 };

/** The scrape's level at every sample: its decay, roughened by grit. */
function scrapeEnvelope(samples: number, rand: () => number): Float32Array {
  const grit = normalized(
    svf(whiteNoise(samples, rand), { mode: 'lowpass', cutoff: GRIT.cutoff, resonance: 0 }).map(
      (sample) => Math.abs(sample)
    )
  );
  return multiply(
    exponentialDecay({ samples, t60: SCRAPE.t60 }),
    grit.map((level) => GRIT.floor + (1 - GRIT.floor) * level)
  );
}

/** The flare's low-pass cutoff at every sample: the swell, the settle, then the burn. */
function flareCutoff(samples: number): Float32Array {
  const cutoff = new Float32Array(samples).fill(FLARE.burnHz);
  const swell = exponentialRamp({
    from: FLARE.fromHz,
    to: FLARE.peakHz,
    samples: Math.min(samples, secondsToSamples(FLARE.swell)),
  });
  const settle = exponentialRamp({
    from: FLARE.peakHz,
    to: FLARE.burnHz,
    samples: Math.min(samples - swell.length, secondsToSamples(FLARE.settle)),
  });
  cutoff.set(swell);
  cutoff.set(settle, swell.length);
  return cutoff;
}

/** A match struck: a gritty scrape, then the flare's swell and burn over a soft thump. */
export const matchStrike: Instrument<z.output<typeof params>> = defineInstrument({
  params,
  percussive: true,
  render({ seconds }, { rand }) {
    const samples = secondsToSamples(seconds);
    const scrapeSamples = secondsToSamples(SCRAPE.length);
    const scrape = excite(
      {
        envelope: scrapeEnvelope(scrapeSamples, rand),
        filter: {
          mode: 'bandpass',
          cutoff: exponentialRamp({ from: SCRAPE.fromHz, to: SCRAPE.toHz, samples: scrapeSamples }),
          resonance: SCRAPE.resonance,
        },
      },
      rand
    );
    const at = secondsToSamples(FLARE.at);
    const flareSamples = samples - at;
    const cutoff = flareCutoff(flareSamples);
    const burn = multiply(
      gate({ samples: flareSamples, attack: secondsToSamples(FLARE.attack), release: 0 }),
      exponentialDecay({ samples: flareSamples, t60: flareSamples / SAMPLE_RATE })
    );
    const fwump = membrane({
      samples: flareSamples,
      startHz: FWUMP.startHz,
      endHz: FWUMP.endHz,
      pitchT60: FWUMP.pitchT60,
      t60: FWUMP.t60,
    });
    const struck = add(
      placedAt(scaled(scrape, SCRAPE.level), 0, samples),
      placedAt(scaled(fwump, FWUMP.level), at, samples)
    );
    const flare = decorrelated(() =>
      placedAt(
        multiply(
          svf(whiteNoise(flareSamples, rand), {
            mode: 'lowpass',
            cutoff,
            resonance: FLARE.resonance,
          }),
          burn
        ),
        at,
        samples
      )
    );
    return anchoredAtStart({ left: add(struck, flare.left), right: add(struck, flare.right) });
  },
});
