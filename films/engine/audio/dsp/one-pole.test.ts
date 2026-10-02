import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';

import { sampleAt } from './buffer.js';
import { expectAttenuated, nextAfter, toneLevelDb } from './dsp-test-support.js';
import { dcBlock, onePole } from './one-pole.js';
import { sine } from './oscillators.js';

import type { Window } from './dsp-test-support.js';
import type { OnePoleOptions } from './one-pole.js';

const SETTLED: Window = { from: 4800, length: 4800 };
const NYQUIST = SAMPLE_RATE / 2;

function toneAt(frequency: number): Float32Array {
  return sine({ frequency, samples: SETTLED.from + SETTLED.length });
}

function gainDb(frequency: number, filter: (input: Float32Array) => Float32Array): number {
  const tone = toneAt(frequency);
  return toneLevelDb(filter(tone), frequency, SETTLED) - toneLevelDb(tone, frequency, SETTLED);
}

const LOWPASS: OnePoleOptions = { mode: 'lowpass', cutoff: 1000 };
const HIGHPASS: OnePoleOptions = { mode: 'highpass', cutoff: 1000 };

describe('onePole low-pass', () => {
  it('stands 3 dB down at its cutoff', () => {
    expect(gainDb(1000, (input) => onePole(input, LOWPASS))).toBeCloseTo(-3.01, 1);
  });

  it('passes a tone one decade below its cutoff to within 0.1 dB', () => {
    expect(Math.abs(gainDb(100, (input) => onePole(input, LOWPASS)))).toBeLessThanOrEqual(0.1);
  });

  it('attenuates a tone one decade above its cutoff by at least 19 dB', () => {
    expectAttenuated(
      gainDb(10_000, (input) => onePole(input, LOWPASS)),
      19
    );
  });
});

describe('onePole high-pass', () => {
  it('stands 3 dB down at its cutoff', () => {
    expect(gainDb(1000, (input) => onePole(input, HIGHPASS))).toBeCloseTo(-3.01, 1);
  });

  it('passes a tone one decade above its cutoff to within 0.5 dB', () => {
    expect(Math.abs(gainDb(10_000, (input) => onePole(input, HIGHPASS)))).toBeLessThanOrEqual(0.5);
  });

  it('attenuates a tone one decade below its cutoff by at least 19 dB', () => {
    expectAttenuated(
      gainDb(100, (input) => onePole(input, HIGHPASS)),
      19
    );
  });
});

describe('onePole bounds', () => {
  const input = new Float32Array([1, 0]);

  it('accepts a cutoff of 0 Hz', () => {
    expect(() => onePole(input, { ...LOWPASS, cutoff: 0 })).not.toThrow();
  });

  it('refuses the double just below 0 Hz', () => {
    expect(() => onePole(input, { ...LOWPASS, cutoff: -Number.MIN_VALUE })).toThrow(
      /cutoff must be in \[0, 24000\)/
    );
  });

  it('accepts the double just below the Nyquist frequency', () => {
    expect(() => onePole(input, { ...LOWPASS, cutoff: nextAfter(NYQUIST, -1) })).not.toThrow();
  });

  it('refuses the Nyquist frequency', () => {
    expect(() => onePole(input, { ...LOWPASS, cutoff: NYQUIST })).toThrow(RangeError);
  });
});

describe('dcBlock', () => {
  it('removes a constant offset', () => {
    const blocked = dcBlock(new Float32Array(SAMPLE_RATE).fill(1));
    expect(Math.abs(sampleAt(blocked, SAMPLE_RATE - 1))).toBeLessThan(1e-6);
  });

  it('passes a 1 kHz tone to within 0.05 dB', () => {
    expect(Math.abs(gainDb(1000, dcBlock))).toBeLessThanOrEqual(0.05);
  });
});
