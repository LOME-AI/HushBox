import { describe, expect, it } from 'vitest';

import { sin } from '../../dmath/dmath.js';
import { SAMPLE_RATE } from '../../time/grid.js';

import { decibels, goertzelPower, nextAfter } from './dsp-test-support.js';
import { saw, sine, square, triangle } from './oscillators.js';

import type { Window } from './dsp-test-support.js';

const NYQUIST = SAMPLE_RATE / 2;
/** 0.1 s: a whole number of cycles of every multiple of 10 Hz, so those bins do not leak. */
const WINDOW: Window = { from: 4800, length: 4800 };
const BIN_WIDTH = SAMPLE_RATE / WINDOW.length;
const AUDIBLE_ALIAS_CEILING = 10_000;

/** A shape sampled with no band-limiting at all, phase counted in cycles. */
function naive(shape: (phase: number) => number, frequency: number, samples: number): Float32Array {
  const output = new Float32Array(samples);
  let phase = 0;
  for (let index = 0; index < samples; index++) {
    output[index] = shape(phase);
    phase += frequency / SAMPLE_RATE;
    if (phase >= 1) {
      phase -= 1;
    }
  }
  return output;
}

/**
 * Power at the bins up to `ceiling`, split into the harmonics of the fundamental
 * and everything else. Everything else is aliasing: a periodic signal has no
 * other components.
 */
function splitPower(
  signal: Float32Array,
  fundamental: number,
  ceiling: number
): { harmonic: number; inharmonic: number } {
  let harmonic = 0;
  let inharmonic = 0;
  for (let bin = 1; bin * BIN_WIDTH <= ceiling; bin++) {
    const frequency = bin * BIN_WIDTH;
    const power = goertzelPower(signal, frequency, WINDOW);
    if (frequency % fundamental === 0) {
      harmonic += power;
    } else {
      inharmonic += power;
    }
  }
  return { harmonic, inharmonic };
}

/** Each band-limited oscillator beside the naive shape it corrects. */
const BAND_LIMITED: {
  name: string;
  oscillator: typeof saw;
  naiveShape: (phase: number) => number;
}[] = [
  { name: 'saw', oscillator: saw, naiveShape: (phase) => 2 * phase - 1 },
  { name: 'square', oscillator: square, naiveShape: (phase) => (phase < 0.5 ? 1 : -1) },
  {
    name: 'triangle',
    oscillator: triangle,
    naiveShape: (phase) => (phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase),
  },
];

describe('sine', () => {
  it('follows sin(2π·f·n / SAMPLE_RATE)', () => {
    const output = sine({ frequency: 1000, samples: 64 });
    for (const [index, sample] of output.entries()) {
      expect(sample).toBeCloseTo(sin((2 * Math.PI * 1000 * index) / SAMPLE_RATE), 6);
    }
  });

  it('keeps its phase wrapped past the sample where an unwrapped 2π·f·t makes dmath’s sin throw', () => {
    // At a quarter cycle per sample the unwrapped argument is (π/2)·n, which
    // passes 1,647,099, where dmath's sin throws, from sample 2^20 on; the first
    // assertion checks the last sample is past it. 2^20 + 4 samples end on a
    // whole cycle, and the quarter-cycle step is exact, so the last cycle repeats
    // the first bit for bit.
    const frequency = SAMPLE_RATE / 4;
    const samples = 2 ** 20 + 4;
    expect(() => sin((2 * Math.PI * frequency * (samples - 1)) / SAMPLE_RATE)).toThrow(RangeError);
    const output = sine({ frequency, samples });
    expect(output[1]).toBe(1);
    expect([...output.subarray(-4)]).toEqual([...output.subarray(0, 4)]);
  });

  it('renders a per-sample frequency that holds one value exactly as that constant', () => {
    const constant = sine({ frequency: 440, samples: 256 });
    const perSample = sine({ frequency: new Float32Array(256).fill(440), samples: 256 });
    expect(perSample).toEqual(constant);
  });

  it('carries its phase across a change of frequency', () => {
    const frequency = new Float32Array([1000, 1000, 2000, 2000]);
    const output = sine({ frequency, samples: 4 });
    // Two steps of 1 kHz, then one of 2 kHz: 4 kHz·(1/SAMPLE_RATE) cycles in all.
    expect(output[3]).toBeCloseTo(sin((2 * Math.PI * 4000) / SAMPLE_RATE), 6);
  });

  it('accepts 0 Hz', () => {
    expect([...sine({ frequency: 0, samples: 3 })]).toEqual([0, 0, 0]);
  });

  it('refuses the double just below 0 Hz', () => {
    expect(() => sine({ frequency: -Number.MIN_VALUE, samples: 3 })).toThrow(
      /frequency must be in \[0, 24000\)/
    );
  });

  it('accepts the double just below the Nyquist frequency', () => {
    expect(() => sine({ frequency: nextAfter(NYQUIST, -1), samples: 3 })).not.toThrow();
  });

  it('refuses the Nyquist frequency', () => {
    expect(() => sine({ frequency: NYQUIST, samples: 3 })).toThrow(RangeError);
  });

  it('names the sample whose per-sample frequency is out of range', () => {
    const frequency = new Float32Array([440, 440, 440, NYQUIST]);
    expect(() => sine({ frequency, samples: 4 })).toThrow(
      'frequency[3] must be in [0, 24000), got 24000'
    );
  });

  it('refuses a per-sample frequency whose length differs from the output', () => {
    expect(() => sine({ frequency: new Float32Array(3), samples: 4 })).toThrow(
      /frequency holds 3 values for 4 samples/
    );
  });

  it('accepts zero samples', () => {
    expect(sine({ frequency: 440, samples: 0 })).toHaveLength(0);
  });

  it('refuses minus one sample', () => {
    expect(() => sine({ frequency: 440, samples: -1 })).toThrow(/samples must be a whole number/);
  });
});

describe.each(BAND_LIMITED)('$name', ({ oscillator, naiveShape }) => {
  it('matches the naive shape away from its corners', () => {
    // 480 Hz is exactly 100 samples per cycle; samples 20 and 70 sit far from every corner.
    const output = oscillator({ frequency: 480, samples: 100 });
    expect([output[20], output[70]]).toEqual([
      Math.fround(naiveShape(0.2)),
      Math.fround(naiveShape(0.7)),
    ]);
  });

  it('holds aliasing below 10 kHz at least 30 dB under the naive shape at 440 Hz', () => {
    const bandLimited = splitPower(
      oscillator({ frequency: 440, samples: 9600 }),
      440,
      AUDIBLE_ALIAS_CEILING
    );
    const plain = splitPower(naive(naiveShape, 440, 9600), 440, AUDIBLE_ALIAS_CEILING);
    // Each side's aliasing is taken relative to its own harmonics, so silence fails.
    const plainRatio = plain.inharmonic / plain.harmonic;
    const bandLimitedRatio = bandLimited.inharmonic / bandLimited.harmonic;
    expect(decibels(plainRatio / bandLimitedRatio)).toBeGreaterThanOrEqual(30);
  });

  it('keeps the naive shape’s harmonics below 10 kHz to within 0.5 dB', () => {
    const bandLimited = splitPower(
      oscillator({ frequency: 440, samples: 9600 }),
      440,
      AUDIBLE_ALIAS_CEILING
    );
    const plain = splitPower(naive(naiveShape, 440, 9600), 440, AUDIBLE_ALIAS_CEILING);
    expect(Math.abs(decibels(plain.harmonic / bandLimited.harmonic))).toBeLessThanOrEqual(0.5);
  });

  it('refuses the Nyquist frequency', () => {
    expect(() => oscillator({ frequency: NYQUIST, samples: 1 })).toThrow(RangeError);
  });
});
