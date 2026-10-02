import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../time/grid.js';
import {
  LOW_BAND_CUTOFF_HZ,
  lowBand,
  lowBandCorrelation,
  stereoCorrelation,
} from './correlation.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** The smallest positive single-precision value. */
const SMALLEST_FLOAT32 = 2 ** -149;

function tone(frequency: number, seconds: number, gain = 1): Float32Array {
  return Float32Array.from(
    { length: seconds * SAMPLE_RATE },
    (_, index) => gain * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE)
  );
}

function sum(a: Float32Array, b: Float32Array): Float32Array {
  return a.map((sample, index) => sample + (b[index] ?? 0));
}

function negate(samples: Float32Array): Float32Array {
  return samples.map((sample) => -sample);
}

/** RMS gain in dB of the second half of `output` against a unit sine's RMS. */
function settledGainDb(output: Float64Array): number {
  const half = output.subarray(output.length / 2);
  let energy = 0;
  for (const sample of half) {
    energy += sample * sample;
  }
  return 20 * Math.log10(Math.sqrt(energy / half.length) / Math.SQRT1_2);
}

describe('stereoCorrelation', () => {
  it('reads identical channels as +1', () => {
    const channel = tone(440, 0.1);
    expect(stereoCorrelation({ left: channel, right: Float32Array.from(channel) })).toBeCloseTo(
      1,
      12
    );
  });

  it('reads inverted channels as −1', () => {
    const channel = tone(440, 0.1);
    expect(stereoCorrelation({ left: channel, right: negate(channel) })).toBeCloseTo(-1, 12);
  });

  it('reads a sine against its cosine as 0', () => {
    const cosine = Float32Array.from({ length: SAMPLE_RATE / 10 }, (_, index) =>
      Math.cos((2 * Math.PI * 1000 * index) / SAMPLE_RATE)
    );
    expect(stereoCorrelation({ left: tone(1000, 0.1), right: cosine })).toBeCloseTo(0, 6);
  });

  it('is undefined when one channel is digital silence', () => {
    expect(
      stereoCorrelation({ left: tone(440, 0.1), right: new Float32Array(SAMPLE_RATE / 10) })
    ).toBeNull();
  });

  it('is defined for the smallest non-zero signal in each channel', () => {
    const signal: StereoBuffer = {
      left: Float32Array.of(SMALLEST_FLOAT32),
      right: Float32Array.of(SMALLEST_FLOAT32),
    };
    expect(stereoCorrelation(signal)).toBe(1);
  });
});

describe('lowBand', () => {
  it('cuts off at 120 Hz', () => {
    expect(LOW_BAND_CUTOFF_HZ).toBe(120);
  });

  it('passes 30 Hz within 0.1 dB', () => {
    expect(Math.abs(settledGainDb(lowBand(tone(30, 2))))).toBeLessThan(0.1);
  });

  it('is 3 dB down at the cutoff', () => {
    expect(settledGainDb(lowBand(tone(LOW_BAND_CUTOFF_HZ, 2)))).toBeCloseTo(-3.01, 1);
  });

  it('falls by at least 45 dB two octaves above the cutoff', () => {
    expect(settledGainDb(lowBand(tone(4 * LOW_BAND_CUTOFF_HZ, 2)))).toBeLessThan(-45);
  });
});

describe('lowBandCorrelation', () => {
  it('reads in-phase bass as +1 under anti-phase treble', () => {
    const bass = tone(60, 2);
    const treble = tone(2000, 2);
    const signal = { left: sum(bass, treble), right: sum(bass, negate(treble)) };
    expect(stereoCorrelation(signal)).toBeCloseTo(0, 1);
    expect(lowBandCorrelation(signal)).toBeGreaterThan(0.99);
  });

  it('reads anti-phase bass as −1 under in-phase treble', () => {
    const bass = tone(60, 2);
    const treble = tone(2000, 2);
    const signal = { left: sum(bass, treble), right: sum(negate(bass), treble) };
    expect(lowBandCorrelation(signal)).toBeLessThan(-0.99);
  });

  it('is undefined for digital silence', () => {
    expect(
      lowBandCorrelation({ left: new Float32Array(10), right: new Float32Array(10) })
    ).toBeNull();
  });
});
