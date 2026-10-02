import { describe, expect, it } from 'vitest';

import {
  linearChannel,
  linearLight,
  linearLuminance,
  lumaPlane,
  meanAndDeviation,
  percentile,
  pixelLuma,
  relativeLuminance,
  requireRaster,
} from './raster.js';

import type { Raster } from './raster.js';

/** A raster of one colour. */
function solid(width: number, height: number, rgb: readonly [number, number, number]): Raster {
  const data = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    data.set(rgb, pixel * 3);
  }
  return { width, height, channels: 3, data };
}

describe('linearChannel', () => {
  it('maps black to 0', () => {
    expect(linearChannel(0)).toBe(0);
  });

  it('maps white to 1', () => {
    expect(linearChannel(255)).toBe(1);
  });

  it('is linear below the sRGB knee', () => {
    expect(linearChannel(10)).toBeCloseTo(10 / 255 / 12.92, 12);
  });

  it('follows the 2.4 power above the knee', () => {
    expect(linearChannel(128)).toBeCloseTo(((128 / 255 + 0.055) / 1.055) ** 2.4, 12);
  });
});

describe('linearLight', () => {
  it('reads each 8-bit value from the table linearChannel fills', () => {
    expect(Array.from({ length: 256 }, (_, value) => linearLight(value))).toEqual(
      Array.from({ length: 256 }, (_, value) => linearChannel(value))
    );
  });

  it('refuses a value past 8 bits', () => {
    expect(() => linearLight(256)).toThrow(/index 256/);
  });
});

describe('relativeLuminance', () => {
  it('is 1 for white', () => {
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 12);
  });

  it('weights red by 0.2126', () => {
    expect(relativeLuminance(255, 0, 0)).toBeCloseTo(0.2126, 12);
  });

  it('weights green by 0.7152', () => {
    expect(relativeLuminance(0, 255, 0)).toBeCloseTo(0.7152, 12);
  });

  it('weights blue by 0.0722', () => {
    expect(relativeLuminance(0, 0, 255)).toBeCloseTo(0.0722, 12);
  });

  it('reads a fractional channel through the sRGB transfer', () => {
    expect(relativeLuminance(127.5, 127.5, 127.5)).toBeCloseTo(linearChannel(127.5), 12);
  });

  it('reads a whole channel as the table holds it', () => {
    expect(relativeLuminance(0, 128, 0)).toBe(0.7152 * linearLight(128));
  });
});

describe('linearLuminance', () => {
  it('weights linear-light red by 0.2126', () => {
    expect(linearLuminance(1, 0, 0)).toBe(0.2126);
  });

  it('weights linear-light green by 0.7152', () => {
    expect(linearLuminance(0, 1, 0)).toBe(0.7152);
  });

  it('weights linear-light blue by 0.0722', () => {
    expect(linearLuminance(0, 0, 1)).toBe(0.0722);
  });

  it('sums the weighted channels', () => {
    expect(linearLuminance(0.25, 0.5, 0.75)).toBe(0.2126 * 0.25 + 0.7152 * 0.5 + 0.0722 * 0.75);
  });
});

describe('pixelLuma', () => {
  it('weights the encoded channels at an offset by BT.709 on the 0–255 scale', () => {
    expect(pixelLuma(Uint8Array.of(9, 100, 200, 50), 1)).toBe(
      0.2126 * 100 + 0.7152 * 200 + 0.0722 * 50
    );
  });

  it('refuses an offset whose pixel runs past the data', () => {
    expect(() => pixelLuma(Uint8Array.of(1, 2), 0)).toThrow(RangeError);
  });
});

describe('lumaPlane', () => {
  it('holds one value per pixel', () => {
    expect(lumaPlane(solid(3, 2, [10, 20, 30]))).toHaveLength(6);
  });

  it('weights the encoded channels by BT.709 on the 0–255 scale', () => {
    expect(lumaPlane(solid(1, 1, [100, 200, 50]))[0]).toBeCloseTo(
      0.2126 * 100 + 0.7152 * 200 + 0.0722 * 50,
      10
    );
  });

  it('skips the alpha channel of a four-channel raster', () => {
    const raster: Raster = { width: 1, height: 1, channels: 4, data: Uint8Array.of(0, 0, 0, 255) };

    expect(lumaPlane(raster)[0]).toBe(0);
  });
});

describe('meanAndDeviation', () => {
  it('gives the mean', () => {
    expect(meanAndDeviation([1, 2, 3, 4]).mean).toBe(2.5);
  });

  it('gives the population standard deviation', () => {
    expect(meanAndDeviation([2, 4, 4, 4, 5, 5, 7, 9]).deviation).toBe(2);
  });

  it('refuses no values', () => {
    expect(() => meanAndDeviation([])).toThrow(/no values/);
  });
});

describe('percentile', () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);

  it('gives the nearest-rank 95th percentile', () => {
    expect(percentile(values, 95)).toBe(95);
  });

  it('gives the largest value at the 100th', () => {
    expect(percentile(values, 100)).toBe(100);
  });

  it('gives the smallest value at the 0th', () => {
    expect(percentile(values, 0)).toBe(1);
  });

  it('does not depend on the order of the values', () => {
    expect(percentile(values.toReversed(), 95)).toBe(95);
  });

  it('refuses no values', () => {
    expect(() => percentile([], 95)).toThrow(/no values/);
  });

  it('refuses a rank above 100', () => {
    expect(() => percentile(values, 100.5)).toThrow(/percentile/);
  });

  it('refuses a rank below 0', () => {
    expect(() => percentile(values, -0.5)).toThrow(/percentile/);
  });

  it('refuses a NaN rank', () => {
    expect(() => percentile(values, Number.NaN)).toThrow(/percentile/);
  });
});

describe('requireRaster', () => {
  it('accepts data holding every channel of every pixel', () => {
    expect(() => {
      requireRaster(solid(2, 2, [0, 0, 0]));
    }).not.toThrow();
  });

  it('refuses data that is short of the pixels it claims', () => {
    expect(() => {
      requireRaster({ width: 2, height: 2, channels: 3, data: new Uint8Array(11) });
    }).toThrow(/12 bytes/);
  });
});
