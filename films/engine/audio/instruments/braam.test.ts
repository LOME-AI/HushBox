import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, SAMPLE_RATE } from '../../time/grid.js';
import { bandPower, nextAfter } from '../dsp/dsp-test-support.js';

import { braam } from './braam.js';
import {
  TEST_FRAMES_PER_BEAT,
  isAudible,
  itHoldsBounds,
  itKeepsTheContract,
  renderWith,
} from './instrument-test-support.js';

describe('braam', () => {
  itKeepsTheContract(braam, { raw: { beats: 2 } });

  itHoldsBounds(braam, [
    { key: 'note', accepted: 24, refused: 23 },
    { key: 'note', accepted: 48, refused: 49 },
    { key: 'beats', accepted: 1 / 16, refused: nextAfter(1 / 16, -1) },
    { key: 'beats', accepted: 64, refused: nextAfter(64, 1), framesPerBeat: 1 },
  ]);

  it('refuses a note between semitones', () => {
    expect(braam.params.safeParse({ note: 30.5 }).success).toBe(false);
  });

  it('lasts its beats, to the sample', () => {
    const { buffer } = renderWith(braam, { beats: 1.5 });
    expect(buffer.left).toHaveLength(1.5 * TEST_FRAMES_PER_BEAT * SAMPLES_PER_FRAME);
  });

  it('blats open, then darkens as it holds', () => {
    const { buffer } = renderWith(braam, { beats: 8 });
    const length = SAMPLE_RATE / 20;
    const brassy = { low: 1500, high: 6000 };
    const opening = bandPower(buffer.left, brassy, { from: 0, length });
    const open = bandPower(buffer.left, brassy, { from: SAMPLE_RATE / 10, length });
    const held = bandPower(buffer.left, brassy, { from: (5 * SAMPLE_RATE) / 2, length });
    expect(open).toBeGreaterThan(opening);
    expect(open).toBeGreaterThan(held * 10);
  });

  it.each([1, 0.5])('sounds a %f-beat hit under its fixed release', (beats) => {
    expect(isAudible(renderWith(braam, { beats }).buffer)).toBe(true);
  });

  it('spreads its voices across the channels', () => {
    const { buffer } = renderWith(braam, { beats: 2 });
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});

describe('braam at its shortest note, a 64th, at framesPerBeat 24', () => {
  itKeepsTheContract(braam, { raw: { beats: 1 / 16 } });
});

describe('braam at its shortest note, a 64th, at framesPerBeat 1', () => {
  itKeepsTheContract(braam, { raw: { beats: 1 / 16 }, framesPerBeat: 1 });
});
