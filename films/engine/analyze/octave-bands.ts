import { SAMPLE_RATE } from '../time/grid.js';

import { powerToDb } from './decibels.js';
import { fft, hann } from './fft.js';
import { requireStereo, sampleAt } from './signal.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** Octave centres on the base-two series through 1 kHz, from 31.25 Hz to 16 kHz. */
export const OCTAVE_CENTERS_HZ: readonly number[] = [
  31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16_000,
];

/** Band edges: each centre divided by √2, then the top band's upper edge. Doubling is exact. */
const BAND_EDGES_HZ = Array.from({ length: OCTAVE_CENTERS_HZ.length + 1 }, (_, edge) => {
  let frequency = 31.25 / Math.SQRT2;
  for (let octave = 0; octave < edge; octave += 1) {
    frequency *= 2;
  }
  return frequency;
});

/** Welch's method: Hann frames of this many samples, advancing by half a frame. */
const WELCH_SIZE = 8192;
const WELCH_HOP = WELCH_SIZE / 2;

export interface OctaveBand {
  readonly centerHz: number;
  /** The band's share of the power in all ten bands, in dB; −Infinity when all ten are silent. */
  readonly levelDb: number;
}

/** The band whose [lower edge, upper edge) holds the frequency, or −1 outside every band. */
export function octaveBandIndex(frequency: number): number {
  let band = -1;
  for (const [edge, edgeFrequency] of BAND_EDGES_HZ.entries()) {
    if (frequency >= edgeFrequency) {
      band = edge;
    }
  }
  return band === OCTAVE_CENTERS_HZ.length ? -1 : band;
}

/** The power spectrum of both channels summed over every frame, bins 0 through WELCH_SIZE / 2. */
function welchPower(signal: StereoBuffer, length: number): Float64Array {
  const window = hann(WELCH_SIZE);
  const power = new Float64Array(WELCH_SIZE / 2 + 1);
  for (let start = 0; start < length; start += WELCH_HOP) {
    for (const channel of [signal.left, signal.right]) {
      const real = window.map((weight, index) => weight * sampleAt(channel, start + index));
      const imag = new Float64Array(WELCH_SIZE);
      fft(real, imag);
      for (const bin of power.keys()) {
        const re = sampleAt(real, bin);
        const im = sampleAt(imag, bin);
        power[bin] = sampleAt(power, bin) + re * re + im * im;
      }
    }
  }
  return power;
}

/** Each octave's share of the signal's power across the ten octaves. */
export function octaveBandBalance(signal: StereoBuffer): OctaveBand[] {
  const length = requireStereo(signal);
  const bandPowers = new Float64Array(OCTAVE_CENTERS_HZ.length);
  for (const [bin, power] of welchPower(signal, length).entries()) {
    const band = octaveBandIndex((bin * SAMPLE_RATE) / WELCH_SIZE);
    if (band >= 0) {
      bandPowers[band] = sampleAt(bandPowers, band) + power;
    }
  }
  let total = 0;
  for (const power of bandPowers) {
    total += power;
  }
  return OCTAVE_CENTERS_HZ.map((centerHz, band) => ({
    centerHz,
    levelDb: total === 0 ? Number.NEGATIVE_INFINITY : powerToDb(sampleAt(bandPowers, band) / total),
  }));
}
