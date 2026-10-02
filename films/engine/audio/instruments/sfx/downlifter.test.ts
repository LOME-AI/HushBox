import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, SAMPLE_RATE } from '../../../time/grid.js';
import { nextAfter } from '../../dsp/dsp-test-support.js';
import { TEST_FRAMES_PER_BEAT, itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { downlifter } from './downlifter.js';
import { bandShare, energy, itKeepsTheSfxContract } from './sfx-test-support.js';

describe('downlifter', () => {
  itKeepsTheSfxContract(downlifter, { raw: {}, anchor: 'start' });

  itHoldsBounds(downlifter, [
    { key: 'beats', accepted: 1 / 16, refused: nextAfter(1 / 16, -1) },
    { key: 'beats', accepted: 64, refused: nextAfter(64, 1), framesPerBeat: 1 },
    { key: 'octaves', accepted: 1, refused: nextAfter(1, -1) },
    { key: 'octaves', accepted: 3, refused: nextAfter(3, 1) },
  ]);

  it('lasts its beats, to the sample', () => {
    const { buffer } = renderWith(downlifter, { beats: 2.5 });
    expect(buffer.left).toHaveLength(2.5 * TEST_FRAMES_PER_BEAT * SAMPLES_PER_FRAME);
  });

  it('fades: its first quarter far louder than its last', () => {
    const { buffer } = renderWith(downlifter, { beats: 4 });
    const quarter = buffer.left.length / 4;
    expect(energy(buffer.left.subarray(0, quarter))).toBeGreaterThan(
      energy(buffer.left.subarray(3 * quarter)) * 100
    );
  });

  it('darkens as it falls', () => {
    const { buffer } = renderWith(downlifter, { beats: 8 });
    const bright = { band: { low: 3000, high: 16_000 }, rest: { low: 0, high: 3000 } };
    const tenth = SAMPLE_RATE / 10;
    expect(bandShare(buffer.left, bright, { from: 0, length: tenth })).toBeGreaterThan(
      bandShare(buffer.left, bright, { from: buffer.left.length / 2, length: tenth }) * 4
    );
  });

  it('spreads its noise across the field', () => {
    const { buffer } = renderWith(downlifter, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});
