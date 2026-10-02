import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';
import { svf } from '../dsp/index.js';

import { excite, membrane } from './drum.js';
import { risingCrossings } from './instrument-test-support.js';
import { impulse } from './voice.js';

import type { SvfOptions } from '../dsp/index.js';

const HALF_SECOND = SAMPLE_RATE / 2;

describe('membrane', () => {
  const hit = membrane({ samples: HALF_SECOND, startHz: 400, endHz: 50, pitchT60: 0.05, t60: 1 });

  it('lasts the samples asked for', () => {
    expect(hit).toHaveLength(HALF_SECOND);
  });

  it('settles on its end pitch once the pitch has fallen', () => {
    const lastTenth = hit.subarray(HALF_SECOND - SAMPLE_RATE / 10);
    expect(risingCrossings(lastTenth)).toBe(5);
  });

  it('starts at its start pitch', () => {
    // Forty-two and a half cycles of 400 Hz. A fall this slow barely moves in the
    // window, so the 42nd cycle ends well inside it and the 43rd well past it.
    const samples = Math.round((42.5 * SAMPLE_RATE) / 400);
    const slow = membrane({ samples, startHz: 400, endHz: 50, pitchT60: 1000, t60: 1 });
    expect(risingCrossings(slow)).toBe(42);
  });

  it('has fallen 60 dB after its t60', () => {
    const short = membrane({
      samples: HALF_SECOND,
      startHz: 100,
      endHz: 100,
      pitchT60: 1,
      t60: 0.25,
    });
    const tail = short.subarray(SAMPLE_RATE / 4);
    expect(Math.max(...Array.from(tail, (sample) => Math.abs(sample)))).toBeLessThanOrEqual(1e-3);
  });
});

describe('excite', () => {
  const HIGHPASS: SvfOptions = { mode: 'highpass', cutoff: 3000, resonance: 0 };

  it('is the filtered strike alone under a silent envelope', () => {
    const struck = excite({ envelope: new Float32Array(64), filter: HIGHPASS }, () => 0.5);
    expect([...struck]).toEqual([...svf(impulse(64, 2), HIGHPASS)]);
  });

  it('keeps its first sample loud when the first noise sample pulls against the strike', () => {
    const envelope = new Float32Array(64).fill(1);
    const struck = excite({ envelope, filter: HIGHPASS }, () => 0);
    expect(Math.abs(struck[0] ?? 0)).toBeGreaterThan(0.5);
  });

  it('carries noise under its envelope', () => {
    const envelope = new Float32Array(64).fill(1);
    const quiet = excite({ envelope: new Float32Array(64), filter: HIGHPASS }, () => 0.9);
    const noisy = excite({ envelope, filter: HIGHPASS }, () => 0.9);
    expect([...noisy]).not.toEqual([...quiet]);
  });
});
