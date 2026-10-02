import { describe, expect, it } from 'vitest';

import { rand } from '../../rand/rand.js';

import { bandPower, decibels } from './dsp-test-support.js';
import { pinkNoise, whiteNoise } from './noise.js';

import type { Window } from './dsp-test-support.js';

/** 0.4 s after a 0.1 s settle: 2.5 Hz bins, a hundred of them in the lower octave. */
const WINDOW: Window = { from: 4800, length: 19_200 };
const LOW_OCTAVE = { low: 250, high: 500 };
const HIGH_OCTAVE = { low: 2000, high: 4000 };

/** High octave power over low octave power, three octaves apart, in dB. */
function octaveTilt(signal: Float32Array): number {
  return decibels(bandPower(signal, HIGH_OCTAVE, WINDOW) / bandPower(signal, LOW_OCTAVE, WINDOW));
}

describe('whiteNoise', () => {
  it('maps each value of the generator from [0, 1) to [−1, 1)', () => {
    const next = rand('white');
    const expected = [next(), next(), next()].map((value) => Math.fround(2 * value - 1));
    expect([...whiteNoise(3, rand('white'))]).toEqual(expected);
  });

  it('is flat: equal power per hertz puts 9 dB more, to within 1 dB, in an octave three octaves up', () => {
    expect(Math.abs(octaveTilt(whiteNoise(24_000, rand('white-tilt'))) - 9)).toBeLessThanOrEqual(1);
  });

  it('accepts zero samples', () => {
    expect(whiteNoise(0, rand('white'))).toHaveLength(0);
  });

  it('refuses minus one sample', () => {
    expect(() => whiteNoise(-1, rand('white'))).toThrow(/samples must be a whole number/);
  });
});

describe('pinkNoise', () => {
  it('is the same for the same generator key', () => {
    expect(pinkNoise(512, rand('pink'))).toEqual(pinkNoise(512, rand('pink')));
  });

  it('differs for a different generator key', () => {
    expect(pinkNoise(512, rand('pink-1'))).not.toEqual(pinkNoise(512, rand('pink-2')));
  });

  it('falls 3 dB per octave: two octaves three octaves apart hold equal power to within 1 dB', () => {
    expect(Math.abs(octaveTilt(pinkNoise(24_000, rand('pink-tilt'))))).toBeLessThanOrEqual(1);
  });

  it('accepts zero samples', () => {
    expect(pinkNoise(0, rand('pink'))).toHaveLength(0);
  });

  it('refuses minus one sample', () => {
    expect(() => pinkNoise(-1, rand('pink'))).toThrow(/samples must be a whole number/);
  });
});
