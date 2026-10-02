import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FPS } from '../time/grid.js';
import { stripFile, takeFrames } from './take-frames.js';

import type { TakeSpec } from './take-frames.js';

const QUARTER_SECOND = FPS / 4;

function take(change: Partial<TakeSpec> = {}): TakeSpec {
  return { durationInFrames: FPS, grid: { framesPerBeat: 24 }, cues: [], ...change };
}

describe('takeFrames', () => {
  it('stills every beat of the tempo that falls inside the take', () => {
    expect(takeFrames(take({ durationInFrames: 96 })).beats).toEqual([0, 24, 48, 72]);
  });

  it('stills a beat on the last frame', () => {
    expect(takeFrames(take({ durationInFrames: 97 })).beats).toEqual([0, 24, 48, 72, 96]);
  });

  it('puts a frame of every quarter second on the contact sheet', () => {
    expect(takeFrames(take()).sheet).toEqual([
      0,
      QUARTER_SECOND,
      2 * QUARTER_SECOND,
      3 * QUARTER_SECOND,
    ]);
  });

  it('strips the three frames either side of a cue', () => {
    const cues = [{ id: 'drop', from: 30 }];

    expect(takeFrames(take({ cues })).strips).toEqual([
      { cueId: 'drop', frame: 30, frames: [27, 28, 29, 30, 31, 32, 33] },
    ]);
  });

  it('cuts a strip at the first frame', () => {
    const cues = [{ id: 'strike', from: 1 }];

    expect(takeFrames(take({ cues })).strips[0]?.frames).toEqual([0, 1, 2, 3, 4]);
  });

  it('cuts a strip at the last frame', () => {
    const cues = [{ id: 'tail', from: FPS - 2 }];

    expect(takeFrames(take({ cues })).strips[0]?.frames).toEqual([
      FPS - 5,
      FPS - 4,
      FPS - 3,
      FPS - 2,
      FPS - 1,
    ]);
  });

  it('strips the frames before a cue on the end boundary', () => {
    const cues = [{ id: 'ring-out', from: FPS }];

    expect(takeFrames(take({ cues })).strips[0]?.frames).toEqual([FPS - 3, FPS - 2, FPS - 1]);
  });

  it('gives each of two cues on one frame its own strip', () => {
    const cues = [
      { id: 'hit', from: 12 },
      { id: 'flash', from: 12 },
    ];

    expect(takeFrames(take({ cues })).strips.map(({ cueId }) => cueId)).toEqual(['hit', 'flash']);
  });

  it('captures every beat, sheet and strip frame once, in frame order', () => {
    const cues = [{ id: 'drop', from: 26 }];

    expect(takeFrames(take({ cues })).captured).toEqual([
      0, 15, 23, 24, 25, 26, 27, 28, 29, 30, 45, 48,
    ]);
  });
});

describe('stripFile', () => {
  it('names a strip by its cue frame, four digits wide, and its cue id', () => {
    expect(stripFile('out', { cueId: 'drop', frame: 30 })).toBe(
      path.join('out', 'strips', '0030-drop.png')
    );
  });
});
