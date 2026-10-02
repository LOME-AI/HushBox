import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME } from '../../time/grid.js';
import { nextAfter } from '../dsp/dsp-test-support.js';

import {
  TEST_FRAMES_PER_BEAT,
  isAudible,
  itHoldsBounds,
  itKeepsTheContract,
  renderWith,
} from './instrument-test-support.js';
import { pad } from './pad.js';

const SAMPLES_PER_BEAT = TEST_FRAMES_PER_BEAT * SAMPLES_PER_FRAME;

/** Root-mean-square level of the samples within `span` of `centre`. */
function levelAround(signal: Float32Array, centre: number, span: number): number {
  let sum = 0;
  const window = signal.subarray(centre - span, centre + span);
  for (const sample of window) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / window.length);
}

describe('pad', () => {
  itKeepsTheContract(pad, { raw: {} });

  itHoldsBounds(pad, [
    { key: 'notes', accepted: [24], refused: [23] },
    { key: 'notes', accepted: [108], refused: [109] },
    { key: 'notes', accepted: [60], refused: [] },
    {
      key: 'notes',
      accepted: [60, 61, 62, 63, 64, 65, 66, 67],
      refused: [60, 61, 62, 63, 64, 65, 66, 67, 68],
    },
    { key: 'beats', accepted: 1 / 16, refused: nextAfter(1 / 16, -1) },
    { key: 'beats', accepted: 64, refused: nextAfter(64, 1), framesPerBeat: 1 },
    { key: 'attack', accepted: 0, refused: -Number.MIN_VALUE },
    { key: 'attack', accepted: 10, refused: nextAfter(10, 1) },
    { key: 'release', accepted: 0, refused: -Number.MIN_VALUE },
    { key: 'release', accepted: 10, refused: nextAfter(10, 1) },
    { key: 'tremolo', accepted: 0, refused: -Number.MIN_VALUE },
    { key: 'tremolo', accepted: 1, refused: nextAfter(1, 1) },
    { key: 'tremoloRate', accepted: 0.25, refused: nextAfter(0.25, -1) },
    { key: 'tremoloRate', accepted: 16, refused: nextAfter(16, 1), framesPerBeat: 1 },
  ]);

  it('lasts its beats, to the sample', () => {
    const { buffer } = renderWith(pad, { beats: 3.25 });
    expect(buffer.left).toHaveLength(3.25 * SAMPLES_PER_BEAT);
  });

  it('swells in over its attack', () => {
    const { buffer } = renderWith(pad, { beats: 4, attack: 1, release: 0 });
    const early = levelAround(buffer.left, SAMPLES_PER_BEAT / 8, SAMPLES_PER_BEAT / 16);
    const late = levelAround(buffer.left, 3 * SAMPLES_PER_BEAT, SAMPLES_PER_BEAT / 16);
    expect(early).toBeLessThan(late / 4);
  });

  it('peaks its tremolo on the beat and dips it between beats', () => {
    const { buffer } = renderWith(pad, { beats: 4, attack: 0, tremolo: 1, tremoloRate: 1 });
    const span = SAMPLES_PER_BEAT / 32;
    const onBeat = levelAround(buffer.left, 2 * SAMPLES_PER_BEAT, span);
    const between = levelAround(buffer.left, 2.5 * SAMPLES_PER_BEAT, span);
    expect(between).toBeLessThan(onBeat / 10);
  });

  it('keeps its level between beats with no tremolo', () => {
    const { buffer } = renderWith(pad, { beats: 4, attack: 0, tremolo: 0 });
    const span = SAMPLES_PER_BEAT / 32;
    const onBeat = levelAround(buffer.left, 2 * SAMPLES_PER_BEAT, span);
    const between = levelAround(buffer.left, 2.5 * SAMPLES_PER_BEAT, span);
    expect(between).toBeGreaterThan(onBeat / 2);
  });

  it.each([2, 3])('sounds a %i-beat chord at its default swell and fade', (beats) => {
    expect(isAudible(renderWith(pad, { beats }).buffer)).toBe(true);
  });

  it('spreads its voices across the channels', () => {
    const { buffer } = renderWith(pad, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});

describe('pad at its shortest note, a 64th, at framesPerBeat 24', () => {
  itKeepsTheContract(pad, { raw: { beats: 1 / 16 } });
});

describe('pad at its shortest note, a 64th, at framesPerBeat 1', () => {
  itKeepsTheContract(pad, { raw: { beats: 1 / 16 }, framesPerBeat: 1 });
});
