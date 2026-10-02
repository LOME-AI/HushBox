import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME, SAMPLE_RATE } from '../../time/grid.js';
import { goertzelPower, nextAfter } from '../dsp/dsp-test-support.js';

import {
  TEST_FRAMES_PER_BEAT,
  itHoldsBounds,
  itKeepsTheContract,
  peakOf,
  renderWith,
} from './instrument-test-support.js';
import { organ } from './organ.js';

/** A tenth of a second, a tenth in: every tone below is a multiple of 10 Hz, so it fills the window. */
const WINDOW = { from: SAMPLE_RATE / 10, length: SAMPLE_RATE / 10 };

describe('organ', () => {
  itKeepsTheContract(organ, { raw: {} });

  itHoldsBounds(organ, [
    { key: 'notes', accepted: [24], refused: [23] },
    { key: 'notes', accepted: [96], refused: [97] },
    { key: 'notes', accepted: [60], refused: [] },
    {
      key: 'notes',
      accepted: [60, 61, 62, 63, 64, 65, 66, 67],
      refused: [60, 61, 62, 63, 64, 65, 66, 67, 68],
    },
    { key: 'beats', accepted: 1 / 16, refused: nextAfter(1 / 16, -1) },
    { key: 'beats', accepted: 64, refused: nextAfter(64, 1), framesPerBeat: 1 },
    { key: 'rotorHz', accepted: 0.1, refused: nextAfter(0.1, -1) },
    { key: 'rotorHz', accepted: 10, refused: nextAfter(10, 1) },
  ]);

  it('refuses a note between semitones', () => {
    expect(organ.params.safeParse({ notes: [60.5] }).success).toBe(false);
  });

  it.each(['88800000', '8880000000', '888000009', '88800000x'])(
    'refuses the registration %s: nine drawbars, each 0 to 8',
    (drawbars) => {
      expect(organ.params.safeParse({ drawbars }).success).toBe(false);
    }
  );

  it('lasts its beats, to the sample', () => {
    const { buffer } = renderWith(organ, { beats: 2.5 });
    expect(buffer.left).toHaveLength(2.5 * TEST_FRAMES_PER_BEAT * SAMPLES_PER_FRAME);
  });

  it('sounds the fundamental drawbar at the note', () => {
    const { buffer } = renderWith(organ, { notes: [69], drawbars: '008000000' });
    const note = goertzelPower(buffer.left, 440, WINDOW);
    expect(note).toBeGreaterThan(goertzelPower(buffer.left, 880, WINDOW) * 1000);
  });

  it('sounds the 4-foot drawbar an octave above the note', () => {
    const { buffer } = renderWith(organ, { notes: [69], drawbars: '000800000' });
    const octave = goertzelPower(buffer.left, 880, WINDOW);
    expect(octave).toBeGreaterThan(goertzelPower(buffer.left, 440, WINDOW) * 1000);
  });

  it('sets each drawbar 3 dB per step', () => {
    const { buffer } = renderWith(organ, { notes: [69], drawbars: '008600000' });
    const fundamental = goertzelPower(buffer.left, 440, WINDOW);
    const octave = goertzelPower(buffer.left, 880, WINDOW);
    expect(10 * Math.log10(fundamental / octave)).toBeCloseTo(6, 0);
  });

  // The one parameter set whose documented output is silence: no drawbar sounds.
  it('is silent with every drawbar in', () => {
    const { buffer } = renderWith(organ, { drawbars: '000000000' });
    expect(peakOf(buffer)).toBe(0);
  });

  it('swings the sound between the channels as the rotor turns', () => {
    const { buffer } = renderWith(organ, {});
    expect([...buffer.right]).not.toEqual([...buffer.left]);
  });
});

describe('organ at its shortest note, a 64th, at framesPerBeat 24', () => {
  itKeepsTheContract(organ, { raw: { beats: 1 / 16 } });
});

describe('organ at its shortest note, a 64th, at framesPerBeat 1', () => {
  itKeepsTheContract(organ, { raw: { beats: 1 / 16 }, framesPerBeat: 1 });
});
