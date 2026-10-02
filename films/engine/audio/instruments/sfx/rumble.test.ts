import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, SAMPLE_RATE } from '../../../time/grid.js';
import { bandPower, goertzelPower, nextAfter } from '../../dsp/dsp-test-support.js';
import { TEST_FRAMES_PER_BEAT, itHoldsBounds, renderWith } from '../instrument-test-support.js';

import { rumble } from './rumble.js';
import { energy, itKeepsTheSfxContract } from './sfx-test-support.js';

describe('rumble', () => {
  itKeepsTheSfxContract(rumble, { raw: {}, anchor: 'start' });

  itHoldsBounds(rumble, [
    { key: 'beats', accepted: 1 / 16, refused: nextAfter(1 / 16, -1) },
    { key: 'beats', accepted: 1024, refused: nextAfter(1024, 1), framesPerBeat: 1 },
    { key: 'toneHz', accepted: 20, refused: nextAfter(20, -1) },
    { key: 'toneHz', accepted: 80, refused: nextAfter(80, 1) },
    { key: 'breathRate', accepted: 1 / 16, refused: nextAfter(1 / 16, -1) },
    { key: 'breathRate', accepted: 4, refused: nextAfter(4, 1) },
  ]);

  it('lasts its beats, to the sample', () => {
    const { buffer } = renderWith(rumble, { beats: 4 });
    expect(buffer.left).toHaveLength(4 * TEST_FRAMES_PER_BEAT * SAMPLES_PER_FRAME);
  });

  it('stays below 400 Hz', () => {
    const { buffer } = renderWith(rumble, { beats: 8 });
    const window = { from: SAMPLE_RATE / 2, length: SAMPLE_RATE / 5 };
    expect(bandPower(buffer.left, { low: 5, high: 400 }, window)).toBeGreaterThan(
      bandPower(buffer.left, { low: 400, high: 4000 }, window) * 100
    );
  });

  it('breathes at its rate: loud at the crest of a breath, quiet at its trough', () => {
    // One breath every four beats at 24 frames per beat: 1.6 s, its crest at 0.8 s.
    const { buffer } = renderWith(rumble, { beats: 8, breathRate: 0.25 });
    const tenth = SAMPLE_RATE / 10;
    const around = (seconds: number): Float32Array => {
      const middle = Math.round(seconds * SAMPLE_RATE);
      return buffer.left.subarray(middle - tenth / 2, middle + tenth / 2);
    };
    expect(energy(around(0.8))).toBeGreaterThan(energy(around(1.6)) * 4);
  });

  it('carries its low tone', () => {
    const { buffer } = renderWith(rumble, { beats: 8, toneHz: 40 });
    // Half a second: 2 Hz bins, 40 Hz on one, 60 Hz off every harmonic of it.
    const window = { from: SAMPLE_RATE / 2, length: SAMPLE_RATE / 2 };
    expect(goertzelPower(buffer.left, 40, window)).toBeGreaterThan(
      goertzelPower(buffer.left, 60, window) * 4
    );
  });

  it('spreads its breath across the field', () => {
    const { buffer } = renderWith(rumble, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});
