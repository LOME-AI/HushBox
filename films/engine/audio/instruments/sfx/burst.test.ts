import { describe, expect, it } from 'vitest';

import { rand } from '../../../rand/rand.js';
import { SAMPLE_RATE } from '../../../time/grid.js';

import { burst, bursts } from './burst.js';
import { energy } from './sfx-test-support.js';

import type { Burst } from './burst.js';

const HIGH: Burst = {
  t60: 0.01,
  filter: { mode: 'highpass', cutoff: 3000, resonance: 0 },
  level: 1,
};

describe('burst', () => {
  it('is as long as asked', () => {
    expect(burst(1234, HIGH, rand('burst'))).toHaveLength(1234);
  });

  it.each(['a', 'b', 'c', 'd', 'e'])(
    'starts on its strike, positive and above −20 dBFS, for seed %s',
    (key) => {
      expect(burst(64, HIGH, rand(key))[0]).toBeGreaterThan(0.1);
    }
  );

  it('falls away over its t60', () => {
    const signal = burst(SAMPLE_RATE / 10, HIGH, rand('burst'));
    const window = SAMPLE_RATE / 200;
    expect(energy(signal.subarray(0, window))).toBeGreaterThan(
      energy(signal.subarray(window * 4, window * 5)) * 1e4
    );
  });

  it('scales by its level', () => {
    const full = burst(256, HIGH, rand('burst'));
    const half = burst(256, { ...HIGH, level: 0.5 }, rand('burst'));
    expect([...half]).toEqual([...full].map((sample) => Math.fround(sample * 0.5)));
  });
});

describe('bursts', () => {
  it('sums the bursts, each drawing its own noise in turn', () => {
    const draw = rand('bursts');
    const first = burst(128, HIGH, draw);
    const second = burst(128, { ...HIGH, level: 0.5 }, draw);
    const summed = bursts(128, [HIGH, { ...HIGH, level: 0.5 }], rand('bursts'));
    expect([...summed]).toEqual(
      [...first].map((sample, index) => Math.fround(sample + (second[index] ?? 0)))
    );
  });

  it('starts a burst `at` seconds in, on its strike', () => {
    const late = bursts(SAMPLE_RATE / 100, [{ ...HIGH, at: 0.005 }], rand('bursts'));
    expect(late.subarray(0, SAMPLE_RATE / 200).every((sample) => sample === 0)).toBe(true);
    expect(late[SAMPLE_RATE / 200]).toBeGreaterThan(0.1);
  });

  it('is silent when given no bursts', () => {
    expect([...bursts(4, [], rand('bursts'))]).toEqual([0, 0, 0, 0]);
  });
});
