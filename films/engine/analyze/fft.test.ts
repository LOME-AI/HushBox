import { describe, expect, it } from 'vitest';

import { fft, hann, magnitudeSpectrum } from './fft.js';

describe('fft', () => {
  it('transforms a unit impulse into a flat spectrum', () => {
    const real = Float64Array.of(1, 0, 0, 0, 0, 0, 0, 0);
    const imag = new Float64Array(8);
    fft(real, imag);
    expect([...real]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect([...imag]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('accepts a single point as its own transform', () => {
    const real = Float64Array.of(0.5);
    const imag = Float64Array.of(0.25);
    fft(real, imag);
    expect([real[0], imag[0]]).toEqual([0.5, 0.25]);
  });

  it('accepts a length of two', () => {
    const real = Float64Array.of(1, 2);
    const imag = new Float64Array(2);
    fft(real, imag);
    expect([...real]).toEqual([3, -1]);
  });

  it('refuses a length of three', () => {
    expect(() => {
      fft(new Float64Array(3), new Float64Array(3));
    }).toThrow(/3/);
  });

  it('refuses an empty input', () => {
    expect(() => {
      fft(new Float64Array(0), new Float64Array(0));
    }).toThrow(/0/);
  });

  it('refuses real and imaginary parts of different lengths', () => {
    expect(() => {
      fft(new Float64Array(4), new Float64Array(8));
    }).toThrow(/4.*8/);
  });
});

describe('hann', () => {
  it('is the periodic Hann window', () => {
    const window = hann(4);
    expect(window[0]).toBe(0);
    expect(window[1]).toBeCloseTo(0.5, 15);
    expect(window[2]).toBe(1);
    expect(window[3]).toBeCloseTo(0.5, 15);
  });
});

describe('magnitudeSpectrum', () => {
  it('returns the magnitudes of bins 0 through N/2 of a real frame', () => {
    const frame = Float64Array.from({ length: 16 }, (_, index) =>
      Math.cos((2 * Math.PI * 3 * index) / 16)
    );
    const spectrum = magnitudeSpectrum(frame);
    expect(spectrum).toHaveLength(9);
    expect(spectrum[3]).toBeCloseTo(8, 12);
    expect(spectrum[2]).toBeCloseTo(0, 12);
  });

  it('leaves its input frame unchanged', () => {
    const frame = Float64Array.of(1, 2, 3, 4);
    magnitudeSpectrum(frame);
    expect([...frame]).toEqual([1, 2, 3, 4]);
  });
});
