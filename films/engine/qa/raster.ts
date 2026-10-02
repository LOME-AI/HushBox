import { at } from './at.js';

/** The colour channels of every pixel, before any alpha. */
export const COLOR_CHANNELS = 3;

/** A decoded image: 8-bit sRGB channels, row by row, with or without alpha. */
export interface Raster {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Uint8Array;
}

/** Refuses a raster whose data does not hold every channel of every pixel it claims. */
export function requireRaster({ width, height, channels, data }: Raster): void {
  const bytes = width * height * channels;
  if (data.length < bytes) {
    throw new RangeError(
      `a ${String(width)}×${String(height)} raster of ${String(channels)} channels needs ${String(bytes)} bytes, got ${String(data.length)}`
    );
  }
}

/** An 8-bit sRGB channel value as linear light, by the sRGB transfer WCAG's relative luminance uses. */
export function linearChannel(value: number): number {
  const encoded = value / 255;
  return encoded <= 0.040_45 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

const LINEAR = Float64Array.from({ length: 256 }, (_, value) => linearChannel(value));

/** {@link linearChannel} of an 8-bit value, read from a table filled once. */
export function linearLight(value: number): number {
  return at(LINEAR, value);
}

/** {@link linearLight} for a whole 8-bit value, {@link linearChannel} for a fractional one such as a mean. */
function linearOf(value: number): number {
  return Number.isInteger(value) ? linearLight(value) : linearChannel(value);
}

/** WCAG 2.2 relative luminance of a colour given as linear-light channels, each from 0 to 1. */
export function linearLuminance(red: number, green: number, blue: number): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * WCAG 2.2 relative luminance of an 8-bit sRGB colour, from 0 (black) to 1
 * (white); a channel may be fractional, as a mean or median of pixels is.
 */
export function relativeLuminance(red: number, green: number, blue: number): number {
  return linearLuminance(linearOf(red), linearOf(green), linearOf(blue));
}

/** The BT.709 luma of the encoded channels of the pixel at `offset`, on the 0–255 scale. */
export function pixelLuma(data: ArrayLike<number>, offset: number): number {
  return 0.2126 * at(data, offset) + 0.7152 * at(data, offset + 1) + 0.0722 * at(data, offset + 2);
}

/** Each pixel's BT.709 luma of the encoded channels, on the 0–255 scale. */
export function lumaPlane(raster: Raster): Float64Array {
  requireRaster(raster);
  const { width, height, channels, data } = raster;
  const plane = new Float64Array(width * height);
  for (let pixel = 0; pixel < plane.length; pixel++) {
    plane[pixel] = pixelLuma(data, pixel * channels);
  }
  return plane;
}

/** The mean and the population standard deviation of the values. */
export function meanAndDeviation(values: ArrayLike<number>): { mean: number; deviation: number } {
  const count = values.length;
  if (count === 0) {
    throw new RangeError('a mean and deviation need values; got no values');
  }
  let sum = 0;
  for (let index = 0; index < count; index++) {
    sum += at(values, index);
  }
  const mean = sum / count;
  let squares = 0;
  for (let index = 0; index < count; index++) {
    const difference = at(values, index) - mean;
    squares += difference * difference;
  }
  return { mean, deviation: Math.sqrt(squares / count) };
}

/** The nearest-rank percentile `rank` (0 to 100) of the values. */
export function percentile(values: ArrayLike<number>, rank: number): number {
  if (!(rank >= 0 && rank <= 100)) {
    throw new RangeError(`a percentile rank lies in [0, 100], got ${String(rank)}`);
  }
  if (values.length === 0) {
    throw new RangeError('a percentile needs values; got no values');
  }
  const sorted = Float64Array.from(values).toSorted();
  const index = Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1);
  return at(sorted, index);
}
