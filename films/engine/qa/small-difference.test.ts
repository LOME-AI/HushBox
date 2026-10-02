import { describe, expect, it } from 'vitest';

import { isSmallDifference, largestChange, smallDifferenceNote } from './small-difference.js';

import type { Raster } from './raster.js';

function raster(channels: 3 | 4, data: number[]): Raster {
  return { width: data.length / channels, height: 1, channels, data: Uint8Array.from(data) };
}

describe('isSmallDifference', () => {
  it('passes an 8×4 block in which every pixel differs by 8 levels', () => {
    expect(isSmallDifference({ pixels: 32, largest: 8 })).toBe(true);
  });

  it('passes a 6×6 blob that differs by up to 3 levels', () => {
    expect(isSmallDifference({ pixels: 36, largest: 3 })).toBe(true);
  });

  it('passes a single value 1 level off', () => {
    expect(isSmallDifference({ pixels: 1, largest: 1 })).toBe(true);
  });

  it('passes 64 differing pixels at 8 levels, the largest difference it allows', () => {
    expect(isSmallDifference({ pixels: 64, largest: 8 })).toBe(true);
  });

  it('fails 65 differing pixels however slight', () => {
    expect(isSmallDifference({ pixels: 65, largest: 1 })).toBe(false);
  });

  it('fails one pixel 9 levels off', () => {
    expect(isSmallDifference({ pixels: 1, largest: 9 })).toBe(false);
  });

  it('fails a 104×104 black square', () => {
    expect(isSmallDifference({ pixels: 104 * 104, largest: 40 })).toBe(false);
  });
});

describe('largestChange', () => {
  it('gives the largest change over the colour channels of one pixel', () => {
    const a = raster(3, [10, 10, 10, 50, 50, 50]);
    const b = raster(3, [10, 10, 10, 47, 56, 50]);

    expect(largestChange(a, b, 1)).toBe(6);
  });

  it('gives 0 for a pixel whose colour channels match', () => {
    const a = raster(3, [10, 20, 30]);

    expect(largestChange(a, a, 0)).toBe(0);
  });

  it('ignores the alpha channel', () => {
    const a = raster(4, [10, 20, 30, 255]);
    const b = raster(4, [10, 20, 30, 0]);

    expect(largestChange(a, b, 0)).toBe(0);
  });

  it('compares rasters with and without alpha pixel for pixel', () => {
    const a = raster(4, [0, 0, 0, 255, 10, 20, 30, 255]);
    const b = raster(3, [0, 0, 0, 10, 22, 30]);

    expect(largestChange(a, b, 1)).toBe(2);
  });
});

describe('smallDifferenceNote', () => {
  it('names the frame, the pixels and the largest change', () => {
    expect(smallDifferenceNote(1045, { pixels: 24, largest: 6 })).toBe(
      'frame 1045 (24 pixels, largest 6)'
    );
  });

  it('names a single pixel in the singular', () => {
    expect(smallDifferenceNote(932, { pixels: 1, largest: 1 })).toBe(
      'frame 932 (1 pixel, largest 1)'
    );
  });
});
