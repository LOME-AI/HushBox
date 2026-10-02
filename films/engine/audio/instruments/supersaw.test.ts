import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, SAMPLE_RATE } from '../../time/grid.js';
import { goertzelPower, nextAfter } from '../dsp/dsp-test-support.js';

import {
  TEST_FRAMES_PER_BEAT,
  itHoldsBounds,
  itKeepsTheContract,
  renderWith,
} from './instrument-test-support.js';
import { supersaw } from './supersaw.js';

/** Both channels summed: every voice, wherever it is placed. */
function mid(buffer: { left: Float32Array; right: Float32Array }): Float32Array {
  return buffer.left.map((left, index) => left + (buffer.right[index] ?? 0));
}

describe('supersaw', () => {
  itKeepsTheContract(supersaw, { raw: {} });

  itHoldsBounds(supersaw, [
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
    { key: 'detune', accepted: 0, refused: -Number.MIN_VALUE },
    { key: 'detune', accepted: 1, refused: nextAfter(1, 1) },
  ]);

  it('lasts its beats, to the sample', () => {
    const { buffer } = renderWith(supersaw, { beats: 0.75 });
    expect(buffer.left).toHaveLength(0.75 * TEST_FRAMES_PER_BEAT * SAMPLES_PER_FRAME);
  });

  it('spreads its voices off the note as the detune rises', () => {
    const window = { from: SAMPLE_RATE / 10, length: SAMPLE_RATE / 5 };
    const tight = mid(renderWith(supersaw, { notes: [69], detune: 0, beats: 2 }).buffer);
    const wide = mid(renderWith(supersaw, { notes: [69], detune: 1, beats: 2 }).buffer);
    const share = (signal: Float32Array): number =>
      goertzelPower(signal, 440, window) / goertzelPower(signal, 440 * 1.1, window);
    expect(share(tight)).toBeGreaterThan(share(wide) * 100);
  });

  it('spreads its voices across the channels', () => {
    const { buffer } = renderWith(supersaw, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});

describe('supersaw at its shortest note, a 64th, at framesPerBeat 24', () => {
  itKeepsTheContract(supersaw, { raw: { beats: 1 / 16 } });
});

describe('supersaw at its shortest note, a 64th, at framesPerBeat 1', () => {
  itKeepsTheContract(supersaw, { raw: { beats: 1 / 16 }, framesPerBeat: 1 });
});
