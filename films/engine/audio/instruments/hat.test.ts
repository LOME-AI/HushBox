import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../time/grid.js';
import { bandPower } from '../dsp/dsp-test-support.js';

import { hat } from './hat.js';
import { itKeepsTheContract, renderWith } from './instrument-test-support.js';

describe('hat, closed', () => {
  itKeepsTheContract(hat, { raw: { variant: 'closed' } });
});

describe('hat, open', () => {
  itKeepsTheContract(hat, { raw: { variant: 'open' } });
});

describe('hat', () => {
  it('is closed unless told otherwise', () => {
    expect(hat.params.parse({})).toEqual({ variant: 'closed' });
  });

  it('refuses a variant it does not have', () => {
    expect(hat.params.safeParse({ variant: 'pedal' }).success).toBe(false);
  });

  it('lasts 80 ms closed, to the sample', () => {
    const { buffer } = renderWith(hat, { variant: 'closed' });
    expect(buffer.left).toHaveLength(3840);
  });

  it('lasts 600 ms open, to the sample', () => {
    const { buffer } = renderWith(hat, { variant: 'open' });
    expect(buffer.left).toHaveLength(28_800);
  });

  it('keeps its energy above 6 kHz', () => {
    const { buffer } = renderWith(hat, { variant: 'open' });
    const window = { from: 0, length: SAMPLE_RATE / 20 };
    const high = bandPower(buffer.left, { low: 6000, high: 20_000 }, window);
    const low = bandPower(buffer.left, { low: 0, high: 2000 }, window);
    expect(high).toBeGreaterThan(low * 100);
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(hat, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
