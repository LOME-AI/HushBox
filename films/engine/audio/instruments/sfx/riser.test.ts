import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, SAMPLE_RATE } from '../../../time/grid.js';
import { nextAfter } from '../../dsp/dsp-test-support.js';
import { TEST_FRAMES_PER_BEAT, itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { riser } from './riser.js';
import { bandShare, energy, itKeepsTheSfxContract } from './sfx-test-support.js';

describe('riser', () => {
  itKeepsTheSfxContract(riser, { raw: {}, anchor: 'end' });

  itHoldsBounds(riser, [
    { key: 'beats', accepted: 1 / 16, refused: nextAfter(1 / 16, -1) },
    { key: 'beats', accepted: 64, refused: nextAfter(64, 1), framesPerBeat: 1 },
    { key: 'octaves', accepted: 1, refused: nextAfter(1, -1) },
    { key: 'octaves', accepted: 3, refused: nextAfter(3, 1) },
  ]);

  it('lasts its beats, to the sample', () => {
    const { buffer } = renderWith(riser, { beats: 1.5 });
    expect(buffer.left).toHaveLength(1.5 * TEST_FRAMES_PER_BEAT * SAMPLES_PER_FRAME);
  });

  it('swells: its last quarter far louder than its first', () => {
    const { buffer } = renderWith(riser, { beats: 4 });
    const quarter = buffer.left.length / 4;
    expect(energy(buffer.left.subarray(3 * quarter))).toBeGreaterThan(
      energy(buffer.left.subarray(0, quarter)) * 100
    );
  });

  it('brightens as it rises: its noise sweeps up', () => {
    const { buffer } = renderWith(riser, { beats: 8 });
    const bright = { band: { low: 3000, high: 16_000 }, rest: { low: 0, high: 3000 } };
    const { length } = buffer.left;
    const tenth = SAMPLE_RATE / 10;
    expect(bandShare(buffer.left, bright, { from: length - tenth, length: tenth })).toBeGreaterThan(
      bandShare(buffer.left, bright, { from: length / 4, length: tenth }) * 4
    );
  });

  it('carries its Shepard layer: partials between 150 Hz and 1.2 kHz as it lands', () => {
    const { buffer } = renderWith(riser, { beats: 8 });
    const tenth = SAMPLE_RATE / 10;
    const window = { from: buffer.left.length - tenth, length: tenth };
    const partials = { band: { low: 150, high: 1200 }, rest: { low: 1200, high: 20_000 } };
    expect(bandShare(buffer.left, partials, window)).toBeGreaterThan(0.008);
  });

  it('spreads its noise across the field', () => {
    const { buffer } = renderWith(riser, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});

describe('riser at its shortest note, a 64th, at framesPerBeat 1', () => {
  itKeepsTheSfxContract(riser, {
    raw: { beats: 1 / 16 },
    anchor: 'end',
    framesPerBeat: 1,
  });
});
