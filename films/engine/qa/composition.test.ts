import { describe, expect, it } from 'vitest';

import { FPS } from '../time/grid.js';

import { cellMeans, compositionLines, compositionMeter, layoutMeans } from './composition.js';

import type { CompositionReport } from './composition.js';
import type { Raster } from './raster.js';

/** Divisible by both grids: 8 layout blocks and 9 travel cells across, 8 and 16 down. */
const WIDTH = 72;
const HEIGHT = 144;

type Rgb = readonly [number, number, number];

function raster(pixel: (x: number, y: number) => Rgb): Raster {
  const data = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      data.set(pixel(x, y), (y * WIDTH + x) * 3);
    }
  }
  return { width: WIDTH, height: HEIGHT, channels: 3, data };
}

function grey(level: number): Raster {
  return raster(() => [level, level, level]);
}

/** The report of a piece `frames` long whose frame `frame` is `picture(frame)`. */
function measure(frames: number, picture: (frame: number) => Raster): CompositionReport {
  const meter = compositionMeter();
  for (let frame = 0; frame < frames; frame++) {
    meter.add(frame, picture(frame));
  }
  return meter.report();
}

/** A uniform grey piece whose level at each frame is `level(frame)`, one raster per level. */
function measureLevels(frames: number, level: (frame: number) => number): CompositionReport {
  const cache = new Map<number, Raster>();
  return measure(frames, (frame) => {
    const value = level(frame);
    const cached = cache.get(value) ?? grey(value);
    cache.set(value, cached);
    return cached;
  });
}

/**
 * Twelve seconds of grey: 0 until 3 s, 40 until 6 s, 50 until 9 s, 100 until
 * 11 s, then 200. The one-second comparisons move 40 at 3 s, 10 at 6 s, 50 at
 * 9 s and 100 at 11 s, so seconds 3, 9 and 11 count and second 6 does not.
 */
function steps(frame: number): number {
  if (frame < 3 * FPS) {
    return 0;
  }
  if (frame < 6 * FPS) {
    return 40;
  }
  if (frame < 9 * FPS) {
    return 50;
  }
  return frame < 11 * FPS ? 100 : 200;
}

/**
 * Three seconds sampled every 1/30 s: sample n reads 2n, plus 10 on odd
 * samples. Each step moves 12 then 8, so any 2 s span (60 samples) churns
 * 30 × 12 + 30 × 8 = 600 and nets 2 × 60 = 120: travel 0.2 on every span.
 */
function driftingFlicker(frame: number): number {
  const sample = Math.floor(frame / 2);
  return 2 * sample + (sample % 2 === 1 ? 10 : 0);
}

describe('layoutMeans', () => {
  it('averages full-range BT.709 luma over an 8×8 grid of blocks', () => {
    const leftColumn = raster((x) => (x < WIDTH / 8 ? [255, 0, 0] : [0, 0, 0]));

    const means = layoutMeans(leftColumn);

    expect(means).toHaveLength(64);
    expect(means[0]).toBeCloseTo(0.2126 * 255, 10);
    expect(means[8]).toBeCloseTo(0.2126 * 255, 10);
    expect(means[1]).toBe(0);
  });
});

describe('cellMeans', () => {
  it('averages each colour channel over 9 columns and 16 rows of cells', () => {
    const lastCell = raster((x, y) =>
      x >= (WIDTH * 8) / 9 && y >= (HEIGHT * 15) / 16 ? [10, 20, 30] : [0, 0, 0]
    );

    const means = cellMeans(lastCell);

    expect(means).toHaveLength(9 * 16 * 3);
    expect(means.slice(-3)).toEqual(Float64Array.of(10, 20, 30));
    expect(means.slice(-6, -3)).toEqual(Float64Array.of(0, 0, 0));
  });
});

describe('composition turnover', () => {
  it('counts the changed seconds in every full 10 s window stepped by 1 s', () => {
    const { turnover } = measureLevels(12 * FPS, steps);

    expect(turnover.windows).toEqual([
      { fromSecond: 0, toSecond: 10, changedSeconds: 2 },
      { fromSecond: 1, toSecond: 11, changedSeconds: 3 },
    ]);
  });

  it('names the window with the fewest changed seconds as the lowest', () => {
    const { turnover } = measureLevels(12 * FPS, steps);

    expect(turnover.lowest).toEqual({ fromSecond: 0, toSecond: 10, changedSeconds: 2 });
  });

  it('names a later window the lowest when it has fewer changed seconds', () => {
    const { turnover } = measureLevels(12 * FPS, (frame) => (frame < FPS ? 0 : 50));

    expect(turnover.lowest).toEqual({ fromSecond: 1, toSecond: 11, changedSeconds: 0 });
  });

  it('marks a piece long enough for full windows as not whole', () => {
    expect(measureLevels(12 * FPS, steps).turnover.wholePiece).toBe(false);
  });

  it('does not count a second whose layout moved exactly 15 levels', () => {
    const { turnover } = measureLevels(2 * FPS, (frame) => (frame < FPS ? 0 : 15));

    expect(turnover.lowest.changedSeconds).toBe(0);
  });

  it('counts a second whose layout moved 16 levels', () => {
    const { turnover } = measureLevels(2 * FPS, (frame) => (frame < FPS ? 0 : 16));

    expect(turnover.lowest.changedSeconds).toBe(1);
  });

  it('counts a layout that moved while its mean brightness held', () => {
    const halves = raster((x) => (x < WIDTH / 2 ? [255, 255, 255] : [0, 0, 0]));
    const mirrored = raster((x) => (x < WIDTH / 2 ? [0, 0, 0] : [255, 255, 255]));

    const { turnover } = measure(2 * FPS, (frame) => (frame < FPS ? halves : mirrored));

    expect(turnover.lowest.changedSeconds).toBe(1);
  });

  it('reads blue by its full-range luma, 0.0722 of its level', () => {
    const blue = raster(() => [0, 0, 220]);

    const { turnover } = measure(2 * FPS, (frame) => (frame < FPS ? grey(0) : blue));

    expect(turnover.lowest.changedSeconds).toBe(1);
  });

  it('gives a piece too short for a full window one window over the whole piece', () => {
    const { turnover } = measureLevels(3 * FPS, driftingFlicker);

    expect(turnover.windows).toEqual([{ fromSecond: 0, toSecond: 2, changedSeconds: 2 }]);
  });

  it('marks the one window of a short piece as the whole piece', () => {
    expect(measureLevels(3 * FPS, driftingFlicker).turnover.wholePiece).toBe(true);
  });

  it('gives a piece of exactly 10 s one window of its 9 comparisons, since its last frame falls short of 10 s', () => {
    const { turnover } = measureLevels(10 * FPS, () => 0);

    expect(turnover.windows).toEqual([{ fromSecond: 0, toSecond: 9, changedSeconds: 0 }]);
  });

  it('marks a piece of exactly 10 s as whole', () => {
    expect(measureLevels(10 * FPS, () => 0).turnover.wholePiece).toBe(true);
  });

  it('marks a piece one frame past 10 s as not whole, since its last frame reaches 10 s', () => {
    expect(measureLevels(10 * FPS + 1, () => 0).turnover.wholePiece).toBe(false);
  });

  it('gives a piece one frame past 10 s a single full window from 0 to 10 s', () => {
    const { turnover } = measureLevels(10 * FPS + 1, () => 0);

    expect(turnover.windows).toEqual([{ fromSecond: 0, toSecond: 10, changedSeconds: 0 }]);
  });

  it('reads zero changed seconds on a held still', () => {
    const { turnover } = measureLevels(12 * FPS, () => 90);

    expect(turnover.windows.map(({ changedSeconds }) => changedSeconds)).toEqual([0, 0]);
  });
});

describe('composition travel', () => {
  it('reads net change over churn on 2 s spans of the 1/30 s grid', () => {
    const { travel } = measureLevels(3 * FPS, driftingFlicker);

    expect(travel).toEqual({ median: expect.closeTo(0.2, 12) as number, spans: 30 });
  });

  it('takes the lower of the two middle spans as the median', () => {
    // Four seconds, one step at 3 s (sample 90): of the 60 spans, those starting
    // at samples 30 to 59 hold it and read 1; the 30 before it read 0.
    const { travel } = measureLevels(4 * FPS, (frame) => (frame < 3 * FPS ? 0 : 50));

    expect(travel).toEqual({ median: 0, spans: 60 });
  });

  it('reads zero on a held still', () => {
    expect(measureLevels(12 * FPS, () => 90).travel).toEqual({ median: 0, spans: 300 });
  });

  it('reads a span that ends where the picture changed', () => {
    expect(measureLevels(2 * FPS + 1, (frame) => (frame < 2 * FPS ? 0 : 50)).travel).toEqual({
      median: 1,
      spans: 1,
    });
  });

  it('is absent, with its reason, when the piece cannot hold one 2 s span', () => {
    expect(measureLevels(2 * FPS, () => 0).travel).toEqual({
      absent: 'the piece is 2.0 s and its last frame falls short of 2 s, so it holds no 2 s span',
    });
  });
});

describe('compositionMeter', () => {
  it('reports the length of the frames it was given', () => {
    expect(measureLevels(96, () => 0).durationSeconds).toBe(1.6);
  });

  it('refuses a frame out of order', () => {
    const meter = compositionMeter();
    meter.add(0, grey(0));

    expect(() => {
      meter.add(2, grey(0));
    }).toThrow('the composition meter reads frames in order: expected frame 1, got frame 2');
  });

  it('refuses a raster whose data is short', () => {
    const meter = compositionMeter();

    expect(() => {
      meter.add(0, { width: WIDTH, height: HEIGHT, channels: 3, data: new Uint8Array(3) });
    }).toThrow(RangeError);
  });

  it('refuses to report on no frames', () => {
    expect(() => compositionMeter().report()).toThrow(
      'the composition meter was given no frames to report on'
    );
  });
});

describe('compositionLines', () => {
  it('prints the lowest full window beside every window', () => {
    expect(compositionLines(measureLevels(12 * FPS, steps))[0]).toBe(
      'composition turnover (reported, not gated): lowest 10 s window 0–10 s with 2 changed seconds; every window: 0–10 s 2, 1–11 s 3'
    );
  });

  it('prints a short piece’s one window with its length', () => {
    expect(compositionLines(measureLevels(96, () => 0))[0]).toBe(
      'composition turnover (reported, not gated): whole piece, 1.6 s, one window 0–1 s with 0 changed seconds'
    );
  });

  it('prints a piece of exactly 10 s as a whole piece', () => {
    expect(compositionLines(measureLevels(10 * FPS, () => 0))[0]).toBe(
      'composition turnover (reported, not gated): whole piece, 10.0 s, one window 0–9 s with 0 changed seconds'
    );
  });

  it('prints travel as a median over its spans', () => {
    expect(compositionLines(measureLevels(3 * FPS, driftingFlicker))[1]).toBe(
      'composition travel (reported, not gated): median net change over churn 0.20 across 30 spans of 2 s'
    );
  });

  it('prints absent travel with its reason', () => {
    expect(compositionLines(measureLevels(96, () => 0))[1]).toBe(
      'composition travel (reported, not gated): absent, the piece is 1.6 s and its last frame falls short of 2 s, so it holds no 2 s span'
    );
  });
});
