import { describe, expect, it } from 'vitest';

import { SAMPLE_RATE } from '../../../time/grid.js';
import { nextAfter } from '../../dsp/dsp-test-support.js';
import { itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { heartbeat } from './heartbeat.js';
import { energy, itKeepsTheSfxContract } from './sfx-test-support.js';

describe('heartbeat', () => {
  itKeepsTheSfxContract(heartbeat, { raw: {}, anchor: 'start' });

  itHoldsBounds(heartbeat, [
    { key: 'toneHz', accepted: 30, refused: nextAfter(30, -1) },
    { key: 'toneHz', accepted: 120, refused: nextAfter(120, 1) },
    { key: 'gap', accepted: 0.08, refused: nextAfter(0.08, -1) },
    { key: 'gap', accepted: 0.5, refused: nextAfter(0.5, 1) },
    { key: 'decay', accepted: 0.08, refused: nextAfter(0.08, -1) },
    { key: 'decay', accepted: 0.6, refused: nextAfter(0.6, 1) },
  ]);

  it('lasts its gap and then its decay, each to the nearest sample', () => {
    const { buffer } = renderWith(heartbeat, { gap: 0.123_45, decay: 0.234_56 });
    expect(buffer.left).toHaveLength(
      Math.round(0.123_45 * SAMPLE_RATE) + Math.round(0.234_56 * SAMPLE_RATE)
    );
  });

  it('beats a second time, its gap after the first', () => {
    const { buffer } = renderWith(heartbeat, { gap: 0.3, decay: 0.2 });
    const second = Math.round(0.3 * SAMPLE_RATE);
    const hundredth = SAMPLE_RATE / 100;
    const before = buffer.left.subarray(second - hundredth, second);
    const after = buffer.left.subarray(second, second + hundredth);
    expect(energy(after)).toBeGreaterThan(energy(before) * 100);
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(heartbeat, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});
