import { SAMPLE_RATE } from '../time/grid.js';
import { pow } from '../dmath/dmath.js';

import { amplitudeToDb } from './decibels.js';
import { hann, magnitudeSpectrum } from './fft.js';
import { blankImage } from './image.js';
import { requireStereo, sampleAt } from './signal.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { GrayImage, ImageSize } from './image.js';

/** The bottom and top of the log-frequency axis. */
export const SPECTROGRAM_MIN_HZ = 20;
export const SPECTROGRAM_MAX_HZ = 20_000;

/** Samples per analysis frame: 43 ms, fine enough in frequency for the lowest rows. */
const FRAME = 2048;

/** A full-scale sine's peak-bin magnitude under a Hann window, drawn white. */
const FULL_SCALE_MAGNITUDE = FRAME / 4;

/** The level drawn black; everything quieter is black too. */
const FLOOR_DB = -120;

/** The fractional FFT bin each row reads, the top row reading the highest frequency. */
function rowBins(height: number): Float64Array {
  return Float64Array.from({ length: height }, (_, row) => {
    const fraction = (height - row - 0.5) / height;
    const frequency = SPECTROGRAM_MIN_HZ * pow(SPECTROGRAM_MAX_HZ / SPECTROGRAM_MIN_HZ, fraction);
    return (frequency * FRAME) / SAMPLE_RATE;
  });
}

function magnitudeAt(spectrum: Float64Array, bin: number): number {
  const lower = Math.floor(bin);
  const fraction = bin - lower;
  return sampleAt(spectrum, lower) * (1 - fraction) + sampleAt(spectrum, lower + 1) * fraction;
}

function pixelLevel(magnitude: number): number {
  const db = Math.min(0, Math.max(FLOOR_DB, amplitudeToDb(magnitude / FULL_SCALE_MAGNITUDE)));
  return Math.round((255 * (db - FLOOR_DB)) / -FLOOR_DB);
}

/**
 * A log-frequency spectrogram of the mono mix: one Hann-windowed frame per
 * column, centred in the column's share of the signal; brightness is level in dB
 * from FLOOR_DB (black) to 0 dBFS (white).
 */
export function spectrogramPixels(signal: StereoBuffer, size: ImageSize): GrayImage {
  const length = requireStereo(signal);
  const image = blankImage(size, 1);
  const mono = signal.left.map((left, index) => (left + sampleAt(signal.right, index)) / 2);
  const window = hann(FRAME);
  const bins = rowBins(image.height);
  for (let column = 0; column < image.width; column += 1) {
    const start = Math.floor(((2 * column + 1) * length) / (2 * image.width)) - FRAME / 2;
    const spectrum = magnitudeSpectrum(
      window.map((weight, index) => weight * sampleAt(mono, start + index))
    );
    for (const [row, bin] of bins.entries()) {
      image.pixels[row * image.width + column] = pixelLevel(magnitudeAt(spectrum, bin));
    }
  }
  return image;
}
