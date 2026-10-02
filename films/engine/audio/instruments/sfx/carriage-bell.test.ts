import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { goertzelPower, nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { carriageBell } from './carriage-bell.js';
import { itKeepsTheSfxContract } from './sfx-test-support.js';

describe('carriageBell', () => {
  itKeepsTheSfxContract(carriageBell, { raw: {}, anchor: 'start' });

  itHoldsBounds(carriageBell, [
    { key: 'toneHz', accepted: 1000, refused: nextAfter(1000, -1) },
    { key: 'toneHz', accepted: 6000, refused: nextAfter(6000, 1) },
    { key: 'decay', accepted: 0.2, refused: nextAfter(0.2, -1) },
    { key: 'decay', accepted: 4, refused: nextAfter(4, 1) },
  ]);

  it('lasts its decay, to the nearest sample', () => {
    const { buffer } = renderWith(carriageBell, { decay: 1.234_56 });
    expect(buffer.left).toHaveLength(Math.round(1.234_56 * SAMPLE_RATE));
  });

  it('rings at its tone', () => {
    const { buffer } = renderWith(carriageBell, { toneHz: 2000 });
    // A tenth of a second from 10 ms: whole cycles of every multiple of 10 Hz.
    const window = { from: SAMPLE_RATE / 100, length: SAMPLE_RATE / 10 };
    expect(goertzelPower(buffer.left, 2000, window)).toBeGreaterThan(
      goertzelPower(buffer.left, 3000, window) * 100
    );
  });

  it('rings an inharmonic partial above its tone, not the octave', () => {
    const { buffer } = renderWith(carriageBell, { toneHz: 2000 });
    const window = { from: SAMPLE_RATE / 100, length: SAMPLE_RATE / 10 };
    expect(goertzelPower(buffer.left, 5510, window)).toBeGreaterThan(
      goertzelPower(buffer.left, 4000, window) * 100
    );
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(carriageBell, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
