import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';

import { expectAttenuated, nextAfter, toneLevelDb } from './dsp-test-support.js';
import { sine } from './oscillators.js';
import { svf } from './svf.js';

import type { Window } from './dsp-test-support.js';
import type { SvfOptions } from './svf.js';

/** 0.1 s after a 0.1 s settle; every tone below is a multiple of 10 Hz, so it fills the window exactly. */
const SETTLED: Window = { from: 4800, length: 4800 };
const NYQUIST = SAMPLE_RATE / 2;
/** q = 1/√2: the maximally flat response. */
const BUTTERWORTH = 1 - Math.SQRT1_2;

/** A tone's level after the filter, in dB relative to its level before. */
function gainDb(frequency: number, options: SvfOptions): number {
  const tone = sine({ frequency, samples: SETTLED.from + SETTLED.length });
  return (
    toneLevelDb(svf(tone, options), frequency, SETTLED) - toneLevelDb(tone, frequency, SETTLED)
  );
}

const LOWPASS: SvfOptions = { mode: 'lowpass', cutoff: 1000, resonance: BUTTERWORTH };

describe('svf low-pass', () => {
  it('attenuates a tone one decade above its cutoff by at least 20 dB', () => {
    expectAttenuated(gainDb(10_000, LOWPASS), 20);
  });

  it('passes a tone one decade below its cutoff to within 0.5 dB', () => {
    expect(Math.abs(gainDb(100, LOWPASS))).toBeLessThanOrEqual(0.5);
  });

  it('falls 12 dB per octave well above its cutoff', () => {
    const options: SvfOptions = { ...LOWPASS, cutoff: 100 };
    expect(gainDb(1000, options) - gainDb(2000, options)).toBeCloseTo(12, 0);
  });

  it('stands 6 dB down at its cutoff with no resonance (q = ½)', () => {
    expect(gainDb(1000, { ...LOWPASS, resonance: 0 })).toBeCloseTo(-6.02, 1);
  });

  it('stands 6 dB up at its cutoff at resonance ¾ (q = 2)', () => {
    expect(gainDb(1000, { ...LOWPASS, resonance: 0.75 })).toBeCloseTo(6.02, 1);
  });
});

describe('svf high-pass', () => {
  const HIGHPASS: SvfOptions = { ...LOWPASS, mode: 'highpass' };

  it('attenuates a tone one decade below its cutoff by at least 20 dB', () => {
    expectAttenuated(gainDb(100, HIGHPASS), 20);
  });

  it('passes a tone one decade above its cutoff to within 0.5 dB', () => {
    expect(Math.abs(gainDb(10_000, HIGHPASS))).toBeLessThanOrEqual(0.5);
  });
});

describe('svf band-pass', () => {
  const BANDPASS: SvfOptions = { ...LOWPASS, mode: 'bandpass' };

  it('passes a tone at its cutoff at unity gain', () => {
    expect(gainDb(1000, BANDPASS)).toBeCloseTo(0, 1);
  });

  it('attenuates a tone one decade away by at least 15 dB', () => {
    expectAttenuated(gainDb(100, BANDPASS), 15);
  });
});

describe('svf notch', () => {
  const NOTCH: SvfOptions = { ...LOWPASS, mode: 'notch' };

  it('removes a tone at its cutoff by at least 40 dB', () => {
    expectAttenuated(gainDb(1000, NOTCH), 40);
  });

  it('passes a tone one decade away to within 0.5 dB', () => {
    expect(Math.abs(gainDb(100, NOTCH))).toBeLessThanOrEqual(0.5);
  });
});

describe('svf per-sample cutoff', () => {
  it('renders a per-sample cutoff that holds one value exactly as that constant', () => {
    const tone = sine({ frequency: 3000, samples: 512 });
    const perSample = svf(tone, { ...LOWPASS, cutoff: new Float32Array(512).fill(1000) });
    expect(perSample).toEqual(svf(tone, LOWPASS));
  });

  it('follows a cutoff that moves mid-buffer', () => {
    const tone = sine({ frequency: 5000, samples: 19_200 });
    const cutoff = new Float32Array(19_200).fill(100, 0, 9600).fill(20_000, 9600);
    const filtered = svf(tone, { ...LOWPASS, cutoff });
    expectAttenuated(toneLevelDb(filtered, 5000, SETTLED), 40);
    expect(toneLevelDb(filtered, 5000, { from: 14_400, length: 4800 })).toBeGreaterThan(-0.5);
  });

  it('names the sample whose cutoff is out of range', () => {
    const cutoff = new Float32Array([1000, 1000, NYQUIST]);
    expect(() => svf(new Float32Array(3), { ...LOWPASS, cutoff })).toThrow(
      'cutoff[2] must be in [0, 24000), got 24000'
    );
  });

  it('refuses a per-sample cutoff whose length differs from the input', () => {
    expect(() => svf(new Float32Array(3), { ...LOWPASS, cutoff: new Float32Array(2) })).toThrow(
      /cutoff holds 2 values for 3 samples/
    );
  });
});

describe('svf bounds', () => {
  const input = new Float32Array([1, 0, 0]);

  it('accepts a cutoff of 0 Hz, where the low-pass passes nothing', () => {
    expect([...svf(input, { ...LOWPASS, cutoff: 0 })]).toEqual([0, 0, 0]);
  });

  it('refuses the double just below 0 Hz', () => {
    expect(() => svf(input, { ...LOWPASS, cutoff: -Number.MIN_VALUE })).toThrow(RangeError);
  });

  it('accepts the double just below the Nyquist frequency', () => {
    expect(() => svf(input, { ...LOWPASS, cutoff: nextAfter(NYQUIST, -1) })).not.toThrow();
  });

  it('refuses the Nyquist frequency', () => {
    expect(() => svf(input, { ...LOWPASS, cutoff: NYQUIST })).toThrow(RangeError);
  });

  it('accepts a resonance of 0', () => {
    expect(() => svf(input, { ...LOWPASS, resonance: 0 })).not.toThrow();
  });

  it('refuses the double just below a resonance of 0', () => {
    expect(() => svf(input, { ...LOWPASS, resonance: -Number.MIN_VALUE })).toThrow(
      /resonance must be in \[0, 1\)/
    );
  });

  it('accepts the double just below a resonance of 1', () => {
    expect(() => svf(input, { ...LOWPASS, resonance: nextAfter(1, -1) })).not.toThrow();
  });

  it('refuses a resonance of 1, where the filter would ring forever', () => {
    expect(() => svf(input, { ...LOWPASS, resonance: 1 })).toThrow(RangeError);
  });
});
