import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';

import { sampleAt } from './buffer.js';
import { nextAfter } from './dsp-test-support.js';
import { adsr, exponentialDecay, exponentialRamp } from './envelopes.js';

import type { AdsrOptions } from './envelopes.js';

const SHAPE: AdsrOptions = { attack: 4, decay: 4, sustain: 0.5, hold: 12, release: 4 };

describe('adsr', () => {
  it('rises, decays, sustains and releases over exact sample counts', () => {
    expect([...adsr(SHAPE)]).toEqual([
      0, 0.25, 0.5, 0.75, 1, 0.875, 0.75, 0.625, 0.5, 0.5, 0.5, 0.5, 0.5, 0.375, 0.25, 0.125,
    ]);
  });

  it('releases from the level it reached when the gate closes mid-attack', () => {
    const early = adsr({ attack: 8, decay: 0, sustain: 1, hold: 4, release: 2 });
    expect([...early]).toEqual([0, 0.125, 0.25, 0.375, 0.5, 0.25]);
  });

  it('starts at full level with no attack', () => {
    expect([...adsr({ attack: 0, decay: 2, sustain: 0.5, hold: 3, release: 0 })]).toEqual([
      1, 0.75, 0.5,
    ]);
  });

  it('accepts a sustain of 0', () => {
    expect(() => adsr({ ...SHAPE, sustain: 0 })).not.toThrow();
  });

  it('refuses the double just below a sustain of 0', () => {
    expect(() => adsr({ ...SHAPE, sustain: -Number.MIN_VALUE })).toThrow(/sustain must be in/);
  });

  it('accepts a sustain of 1', () => {
    expect(() => adsr({ ...SHAPE, sustain: 1 })).not.toThrow();
  });

  it('refuses the double just above a sustain of 1', () => {
    expect(() => adsr({ ...SHAPE, sustain: nextAfter(1, 1) })).toThrow(RangeError);
  });

  it.each(['attack', 'decay', 'hold', 'release'] as const)('accepts a %s of 0 samples', (key) => {
    expect(() => adsr({ ...SHAPE, [key]: 0 })).not.toThrow();
  });

  it.each(['attack', 'decay', 'hold', 'release'] as const)(
    'refuses a %s of minus one sample',
    (key) => {
      expect(() => adsr({ ...SHAPE, [key]: -1 })).toThrow(`${key} must be a whole number`);
    }
  );
});

describe('exponentialDecay', () => {
  it('starts at 1', () => {
    expect(exponentialDecay({ samples: 2, t60: 1 })[0]).toBe(1);
  });

  it('has fallen 60 dB after t60 seconds', () => {
    const t60 = 0.01;
    const decay = exponentialDecay({ samples: t60 * SAMPLE_RATE + 1, t60 });
    expect(decay.at(-1)).toBeCloseTo(0.001, 9);
  });

  it('falls by the same ratio every sample', () => {
    const decay = exponentialDecay({ samples: 3, t60: 0.001 });
    const ratio = sampleAt(decay, 1) / sampleAt(decay, 0);
    expect(sampleAt(decay, 2)).toBeCloseTo(sampleAt(decay, 1) * ratio, 6);
  });

  it('accepts the smallest positive t60', () => {
    expect([...exponentialDecay({ samples: 2, t60: Number.MIN_VALUE })]).toEqual([1, 0]);
  });

  it('refuses a t60 of 0', () => {
    expect(() => exponentialDecay({ samples: 2, t60: 0 })).toThrow('t60 must be in (0, Infinity)');
  });

  it('accepts the largest finite t60', () => {
    expect([...exponentialDecay({ samples: 2, t60: Number.MAX_VALUE })]).toEqual([1, 1]);
  });

  it('refuses an infinite t60', () => {
    expect(() => exponentialDecay({ samples: 2, t60: Number.POSITIVE_INFINITY })).toThrow(
      RangeError
    );
  });

  it('refuses minus one sample', () => {
    expect(() => exponentialDecay({ samples: -1, t60: 1 })).toThrow(/samples must be/);
  });
});

describe('exponentialRamp', () => {
  it('moves by a constant ratio from its first value to its last', () => {
    const ramp = exponentialRamp({ from: 1000, to: 10, samples: 3 });
    expect([ramp[0], ramp[2]]).toEqual([1000, 10]);
    expect(ramp[1]).toBeCloseTo(100, 4);
  });

  it('holds its first value when it lasts one sample', () => {
    expect([...exponentialRamp({ from: 440, to: 880, samples: 1 })]).toEqual([440]);
  });

  it.each(['from', 'to'] as const)('accepts the smallest positive %s', (key) => {
    expect(() =>
      exponentialRamp({ from: 1, to: 1, samples: 2, [key]: Number.MIN_VALUE })
    ).not.toThrow();
  });

  it.each(['from', 'to'] as const)('refuses a %s of 0', (key) => {
    expect(() => exponentialRamp({ from: 1, to: 1, samples: 2, [key]: 0 })).toThrow(
      `${key} must be in (0, Infinity), got 0`
    );
  });

  it.each(['from', 'to'] as const)('accepts the largest finite %s', (key) => {
    expect(() =>
      exponentialRamp({ from: 1, to: 1, samples: 2, [key]: Number.MAX_VALUE })
    ).not.toThrow();
  });

  it.each(['from', 'to'] as const)('refuses an infinite %s', (key) => {
    expect(() =>
      exponentialRamp({ from: 1, to: 1, samples: 2, [key]: Number.POSITIVE_INFINITY })
    ).toThrow(RangeError);
  });

  it('accepts zero samples', () => {
    expect(exponentialRamp({ from: 1, to: 2, samples: 0 })).toHaveLength(0);
  });

  it('refuses minus one sample', () => {
    expect(() => exponentialRamp({ from: 1, to: 2, samples: -1 })).toThrow(/samples must be/);
  });
});
