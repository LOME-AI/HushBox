import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, SAMPLE_RATE } from '../../time/grid.js';
import { nextAfter } from '../dsp/dsp-test-support.js';

import {
  TEST_FRAMES_PER_BEAT,
  itHoldsBounds,
  itKeepsTheContract,
  renderWith,
  risingCrossings,
} from './instrument-test-support.js';
import { sub808 } from './sub808.js';

const TENTH = SAMPLE_RATE / 10;

describe('sub808', () => {
  itKeepsTheContract(sub808, { raw: {} });

  itHoldsBounds(sub808, [
    { key: 'note', accepted: 12, refused: 11 },
    { key: 'note', accepted: 60, refused: 61 },
    { key: 'beats', accepted: 1 / 16, refused: nextAfter(1 / 16, -1) },
    { key: 'beats', accepted: 64, refused: nextAfter(64, 1), framesPerBeat: 1 },
    { key: 'glideFrom', accepted: 12, refused: 11 },
    { key: 'glideFrom', accepted: 60, refused: 61 },
    { key: 'glide', accepted: 0.005, refused: nextAfter(0.005, -1) },
    { key: 'glide', accepted: 2, refused: nextAfter(2, 1) },
    { key: 'decay', accepted: 0.05, refused: nextAfter(0.05, -1) },
    { key: 'decay', accepted: 10, refused: nextAfter(10, 1) },
    { key: 'drive', accepted: 0.5, refused: nextAfter(0.5, -1) },
    { key: 'drive', accepted: 8, refused: nextAfter(8, 1) },
  ]);

  it('refuses a note between semitones', () => {
    expect(sub808.params.safeParse({ note: 36.5 }).success).toBe(false);
  });

  it('lasts its beats, to the sample', () => {
    const { buffer } = renderWith(sub808, { beats: 1.5 });
    expect(buffer.left).toHaveLength(1.5 * TEST_FRAMES_PER_BEAT * SAMPLES_PER_FRAME);
  });

  it('refuses a length that falls between samples', () => {
    expect(() => renderWith(sub808, { beats: 1 / 7 })).toThrow(/whole number of samples/);
  });

  it('sounds its note', () => {
    const { buffer } = renderWith(sub808, { note: 33, beats: 2 });
    // Two tenths of a second, a tenth in: eleven cycles of A1 at 55 Hz.
    expect(risingCrossings(buffer.left.subarray(TENTH, 3 * TENTH))).toBe(11);
  });

  it('glides down to its note from the note it slides from', () => {
    const steady = renderWith(sub808, { note: 33, beats: 2 }).buffer.left;
    const glided = renderWith(sub808, { note: 33, glideFrom: 45, glide: 2, beats: 2 }).buffer.left;
    expect(risingCrossings(glided.subarray(0, TENTH))).toBeGreaterThan(
      risingCrossings(steady.subarray(0, TENTH)) + 2
    );
  });

  it('has reached its note once the glide is over', () => {
    const { buffer } = renderWith(sub808, { note: 33, glideFrom: 45, glide: 0.05, beats: 2 });
    expect(risingCrossings(buffer.left.subarray(TENTH, 3 * TENTH))).toBe(11);
  });

  it('fades out as the note ends', () => {
    const { buffer } = renderWith(sub808, {});
    expect(Math.abs(buffer.left.at(-1) ?? 1)).toBeLessThan(0.01);
  });

  it('puts the same signal in both channels', () => {
    const { buffer } = renderWith(sub808, {});
    expect([...buffer.right]).toEqual([...buffer.left]);
  });
});

describe('sub808 at its shortest note, a 64th, at framesPerBeat 24', () => {
  itKeepsTheContract(sub808, { raw: { beats: 1 / 16 } });
});

describe('sub808 at its shortest note, a 64th, at framesPerBeat 1', () => {
  itKeepsTheContract(sub808, { raw: { beats: 1 / 16 }, framesPerBeat: 1 });
});
