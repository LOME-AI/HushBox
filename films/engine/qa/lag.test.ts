import { describe, expect, it } from 'vitest';

import { LAG_SEARCH, signalLag } from './lag.js';

import type { StereoBuffer } from '../audio/dsp/index.js';

/** Seeded pseudo-noise, so the correlation has one clear peak. */
function noise(length: number): Float32Array {
  let state = 12_345;
  return Float32Array.from({ length }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 1_073_741_824 - 1;
  });
}

const MASTER_SAMPLES = 20_000;
const MASTER: StereoBuffer = {
  left: noise(MASTER_SAMPLES),
  right: noise(MASTER_SAMPLES).toReversed(),
};

/** The master delayed by `lag` samples: zeros first, then the master. */
function delayed(lag: number): StereoBuffer {
  const shift = (channel: Float32Array): Float32Array => {
    const out = new Float32Array(channel.length + lag);
    out.set(channel, lag);
    return out;
  };
  return { left: shift(MASTER.left), right: shift(MASTER.right) };
}

describe('signalLag', () => {
  it('finds a delay of 1600 samples exactly', () => {
    expect(signalLag(delayed(1600), MASTER)).toBe(1600);
  });

  it('finds a delay of 0', () => {
    expect(signalLag(MASTER, MASTER)).toBe(0);
  });

  it('finds a delay one sample off', () => {
    expect(signalLag(delayed(1601), MASTER)).toBe(1601);
  });

  it('finds a signal that leads the master', () => {
    const early = { left: MASTER.left.subarray(5), right: MASTER.right.subarray(5) };

    expect(signalLag(early, MASTER)).toBe(-5);
  });

  it('searches as far as the search bound', () => {
    expect(signalLag(delayed(LAG_SEARCH), MASTER)).toBe(LAG_SEARCH);
  });

  it('refuses silence, which has no lag', () => {
    const silent = { left: new Float32Array(100), right: new Float32Array(100) };

    expect(() => signalLag(silent, MASTER)).toThrow(/silent/);
  });
});
