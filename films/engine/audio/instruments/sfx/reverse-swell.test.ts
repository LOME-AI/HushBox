import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, SAMPLE_RATE } from '../../../time/grid.js';
import { bandPower, nextAfter } from '../../dsp/dsp-test-support.js';
import { TEST_FRAMES_PER_BEAT, itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { reverseSwell } from './reverse-swell.js';
import { energy, itKeepsTheSfxContract } from './sfx-test-support.js';

describe('reverseSwell', () => {
  itKeepsTheSfxContract(reverseSwell, { raw: {}, anchor: 'end' });

  itHoldsBounds(reverseSwell, [
    { key: 'beats', accepted: 1 / 16, refused: nextAfter(1 / 16, -1) },
    { key: 'beats', accepted: 64, refused: nextAfter(64, 1), framesPerBeat: 1 },
  ]);

  it('lasts its beats, to the sample', () => {
    const { buffer } = renderWith(reverseSwell, { beats: 3 });
    expect(buffer.left).toHaveLength(3 * TEST_FRAMES_PER_BEAT * SAMPLES_PER_FRAME);
  });

  it('swells into its cue: its last tenth far louder than its first', () => {
    const { buffer } = renderWith(reverseSwell, { beats: 4 });
    const tenth = buffer.left.length / 10;
    expect(energy(buffer.left.subarray(9 * tenth))).toBeGreaterThan(
      energy(buffer.left.subarray(0, tenth)) * 1000
    );
  });

  it('is cymbal-bright: more energy above 3 kHz than below 1 kHz as it lands', () => {
    const { buffer } = renderWith(reverseSwell, { beats: 4 });
    const window = { from: buffer.left.length - SAMPLE_RATE / 10, length: SAMPLE_RATE / 10 };
    expect(bandPower(buffer.left, { low: 3000, high: 16_000 }, window)).toBeGreaterThan(
      bandPower(buffer.left, { low: 0, high: 1000 }, window) * 10
    );
  });

  it('spreads across the field', () => {
    const { buffer } = renderWith(reverseSwell, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});

describe('reverseSwell at its shortest note, a 64th, at framesPerBeat 1', () => {
  itKeepsTheSfxContract(reverseSwell, {
    raw: { beats: 1 / 16 },
    anchor: 'end',
    framesPerBeat: 1,
  });
});
