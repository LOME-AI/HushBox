import { describe, expect, it } from 'vitest';

import {
  FPS,
  HEIGHT,
  SAMPLE_RATE,
  SAMPLES_PER_FRAME,
  WIDTH,
  barToFrame,
  beatToFrame,
  bpmOf,
  frameToSample,
} from './grid.js';

import type { Grid } from './grid.js';

const GRID_150_BPM: Grid = { framesPerBeat: 24, beatsPerBar: 4 };

describe('timebase constants', () => {
  it('renders 60 frames per second', () => {
    expect(FPS).toBe(60);
  });

  it('samples audio at 48 kHz', () => {
    expect(SAMPLE_RATE).toBe(48_000);
  });

  it('holds exactly 800 samples per frame', () => {
    expect(SAMPLES_PER_FRAME).toBe(800);
  });

  it('frames the picture at 1080 by 1920', () => {
    expect([WIDTH, HEIGHT]).toEqual([1080, 1920]);
  });
});

describe('bpmOf', () => {
  it('derives the tempo from frames per beat', () => {
    expect(bpmOf(GRID_150_BPM)).toBe(150);
  });
});

describe('beatToFrame', () => {
  it('maps an integer beat to its frame', () => {
    expect(beatToFrame(GRID_150_BPM, 3)).toBe(72);
  });

  it('maps a quarter beat to its frame', () => {
    expect(beatToFrame(GRID_150_BPM, 2.25)).toBe(54);
  });

  it('throws when a beat lands between frames', () => {
    expect(() => beatToFrame({ framesPerBeat: 25, beatsPerBar: 4 }, 0.25)).toThrow(RangeError);
  });

  it('names the beat and framesPerBeat when a beat lands between frames', () => {
    expect(() => beatToFrame({ framesPerBeat: 25, beatsPerBar: 4 }, 0.25)).toThrow(
      /beat 0\.25.*framesPerBeat 25/
    );
  });
});

describe('barToFrame', () => {
  it('maps a bar to the frame of its first beat', () => {
    expect(barToFrame(GRID_150_BPM, 2)).toBe(192);
  });
});

describe('frameToSample', () => {
  it('maps a frame to its first audio sample', () => {
    expect(frameToSample(3)).toBe(2400);
  });
});
