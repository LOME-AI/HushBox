import { describe, expect, it } from 'vitest';

import { applyDuck, duckGains } from './duck.js';

import type { Duck } from './define-score.js';

const DUCK: Duck = { cueSamples: [100, 400], floor: 0.25, releaseSamples: 200 };

describe('duckGains', () => {
  it('holds unity before the first cue', () => {
    expect([...duckGains(1000, DUCK).subarray(0, 100)].every((gain) => gain === 1)).toBe(true);
  });

  it('drops to the floor on the cue’s own sample', () => {
    expect(duckGains(1000, DUCK)[100]).toBe(0.25);
  });

  it('recovers along u^1.5 over the release', () => {
    const quarter = 0.25 + 0.75 * 0.25 * Math.sqrt(0.25);
    expect(duckGains(1000, DUCK)[150]).toBeCloseTo(quarter, 6);
  });

  it('is back at unity once the release has run', () => {
    expect(duckGains(1000, DUCK)[300]).toBe(1);
  });

  it('takes the deeper of two overlapping ducks', () => {
    const gains = duckGains(1000, { cueSamples: [100, 150], floor: 0.25, releaseSamples: 200 });
    expect(gains[150]).toBe(0.25);
    expect(gains[200]).toBeCloseTo(0.25 + 0.75 * 0.25 * Math.sqrt(0.25), 6);
  });

  it('stops a release that would run past the end', () => {
    const gains = duckGains(500, DUCK);
    expect(gains).toHaveLength(500);
    expect(gains[499]).toBeLessThan(1);
  });

  it('ducks nothing at a floor of unity', () => {
    const gains = duckGains(1000, { ...DUCK, floor: 1 });
    expect([...gains].every((gain) => gain === 1)).toBe(true);
  });
});

describe('applyDuck', () => {
  it('scales both channels by the gains', () => {
    const left = new Float32Array(1000).fill(0.5);
    const right = new Float32Array(1000).fill(-0.5);
    const ducked = applyDuck({ left, right }, DUCK);
    expect([ducked.left[100], ducked.right[100], ducked.left[50]]).toEqual([0.125, -0.125, 0.5]);
  });
});
