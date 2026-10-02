import { describe, expect, it } from 'vitest';

import { FilmRenderError } from './film-error.js';
import { probeFrames, requireFrames, withNeighbours } from './probe-frames.js';

import type { ProbeSpec } from './probe-frames.js';

const ONE_SHOT: ProbeSpec = { durationInFrames: 96, shots: [{ from: 0, to: 96 }], cues: [] };

describe('probeFrames', () => {
  it('holds the first frame, the shot midpoint and the last frame of a one-shot film', () => {
    expect(probeFrames(ONE_SHOT)).toEqual([0, 48, 95]);
  });

  it('holds each cut frame and the frame before it', () => {
    const spec: ProbeSpec = {
      durationInFrames: 192,
      shots: [
        { from: 0, to: 96 },
        { from: 96, to: 192 },
      ],
      cues: [],
    };

    expect(probeFrames(spec)).toEqual(expect.arrayContaining([95, 96]));
  });

  it('holds every cue frame', () => {
    expect(probeFrames({ ...ONE_SHOT, cues: [{ from: 7 }, { from: 60 }] })).toEqual([
      0, 7, 48, 60, 95,
    ]);
  });

  it('leaves out a cue on the end boundary, which is no frame of the film', () => {
    expect(probeFrames({ ...ONE_SHOT, cues: [{ from: 96 }] })).toEqual([0, 48, 95]);
  });

  it('puts an odd-length shot midpoint on the frame below the half', () => {
    expect(probeFrames({ durationInFrames: 5, shots: [{ from: 0, to: 5 }], cues: [] })).toEqual([
      0, 2, 4,
    ]);
  });

  it('lists each frame once, ascending, however many reasons name it', () => {
    const spec: ProbeSpec = { ...ONE_SHOT, cues: [{ from: 48 }, { from: 0 }, { from: 95 }] };

    expect(probeFrames(spec)).toEqual([0, 48, 95]);
  });

  it('holds only frame 0 of a one-frame film', () => {
    expect(probeFrames({ durationInFrames: 1, shots: [{ from: 0, to: 1 }], cues: [] })).toEqual([
      0,
    ]);
  });
});

describe('withNeighbours', () => {
  it('adds the frame before and after each frame', () => {
    expect(withNeighbours([48], 96)).toEqual([47, 48, 49]);
  });

  it('adds no frame before the first frame of the film', () => {
    expect(withNeighbours([0], 96)).toEqual([0, 1]);
  });

  it('adds no frame after the last frame of the film', () => {
    expect(withNeighbours([95], 96)).toEqual([94, 95]);
  });

  it('lists each frame once, ascending', () => {
    expect(withNeighbours([5, 3], 96)).toEqual([2, 3, 4, 5, 6]);
  });
});

/** What `requireFrames` throws for these frames of a 96-frame film, or null when it accepts them. */
function refusal(frames: readonly number[]): unknown {
  try {
    requireFrames('engine-render', frames, 96);
  } catch (error) {
    return error;
  }
  return null;
}

describe('requireFrames', () => {
  it('accepts the first frame', () => {
    expect(refusal([0])).toBeNull();
  });

  it('accepts the last frame', () => {
    expect(refusal([95])).toBeNull();
  });

  it('refuses the frame one past the last', () => {
    expect(refusal([96])).toBeInstanceOf(FilmRenderError);
  });

  it('refuses a frame before the first', () => {
    expect(refusal([-1])).toBeInstanceOf(FilmRenderError);
  });

  it('refuses a frame between frames', () => {
    expect(refusal([1.5])).toBeInstanceOf(FilmRenderError);
  });

  it('refuses NaN', () => {
    expect(refusal([Number.NaN])).toBeInstanceOf(FilmRenderError);
  });

  it('names the film, the rule and the frame it refuses', () => {
    expect(refusal([3, 96])).toHaveProperty(
      'message',
      'engine-render: frames: frame 96 is not a frame of the film, which runs from 0 to 95'
    );
  });

  it('refuses an empty list, naming the film', () => {
    expect(refusal([])).toHaveProperty('message', 'engine-render: frames: no frame was given');
  });
});
