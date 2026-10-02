import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, SAMPLE_RATE } from '../../../time/grid.js';
import { bandPower, nextAfter } from '../../dsp/dsp-test-support.js';
import { TEST_FRAMES_PER_BEAT, itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { roomTone } from './room-tone.js';
import { energy, itKeepsTheSfxContract } from './sfx-test-support.js';

describe('roomTone', () => {
  itKeepsTheSfxContract(roomTone, { raw: {}, anchor: 'start' });

  itHoldsBounds(roomTone, [
    { key: 'beats', accepted: 1 / 16, refused: nextAfter(1 / 16, -1) },
    { key: 'beats', accepted: 1024, refused: nextAfter(1024, 1), framesPerBeat: 1 },
    { key: 'cutoff', accepted: 60, refused: nextAfter(60, -1) },
    { key: 'cutoff', accepted: 2000, refused: nextAfter(2000, 1) },
  ]);

  it('lasts its beats, to the sample', () => {
    const { buffer } = renderWith(roomTone, { beats: 75 });
    expect(buffer.left).toHaveLength(75 * TEST_FRAMES_PER_BEAT * SAMPLES_PER_FRAME);
  });

  it('stays low: far more energy below its cutoff than an octave and a half above it', () => {
    const { buffer } = renderWith(roomTone, { beats: 8, cutoff: 240 });
    const window = { from: SAMPLE_RATE, length: SAMPLE_RATE / 10 };
    expect(bandPower(buffer.left, { low: 20, high: 240 }, window)).toBeGreaterThan(
      bandPower(buffer.left, { low: 720, high: 4000 }, window) * 20
    );
  });

  it('rises from silence', () => {
    expect(Math.abs(renderWith(roomTone, {}).buffer.left[0] ?? Number.NaN)).toBe(0);
  });

  it('fades to near silence by its end', () => {
    const { buffer } = renderWith(roomTone, { beats: 8 });
    const milli = SAMPLE_RATE / 1000;
    const middle = buffer.left.length / 2;
    expect(energy(buffer.left.subarray(buffer.left.length - milli))).toBeLessThan(
      energy(buffer.left.subarray(middle, middle + milli)) / 100
    );
  });

  it('spreads across the field', () => {
    const { buffer } = renderWith(roomTone, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});
