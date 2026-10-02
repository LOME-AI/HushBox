import { blankImage } from './image.js';
import { requireCueSample, requireStereo } from './signal.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { GrayImage, ImageSize } from './image.js';
import type { AnalysisCue } from './signal.js';

/** Brightness of the waveform trace. */
export const WAVEFORM_LEVEL = 255;

/** Brightness of a cue marker's dashes, drawn over the trace so a marker in a loud passage still shows. */
export const MARKER_LEVEL = 128;

/** Rows per dash and per gap of a cue marker. */
const DASH_ROWS = 4;

interface Lane {
  readonly top: number;
  readonly height: number;
}

/** The samples a column draws: its share of the signal, or the one sample under it when shares are empty. */
function columnSamples(
  column: number,
  width: number,
  length: number
): readonly [start: number, end: number] {
  const start = Math.floor((column * length) / width);
  const end = Math.max(start + 1, Math.floor(((column + 1) * length) / width));
  return [start, Math.min(end, length)];
}

function rowOf(amplitude: number, lane: Lane): number {
  const clamped = Math.min(1, Math.max(-1, amplitude));
  return lane.top + Math.round(((1 - clamped) / 2) * (lane.height - 1));
}

function drawColumn(image: GrayImage, column: number, lane: Lane, samples: Float32Array): void {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    low = Math.min(low, sample);
    high = Math.max(high, sample);
  }
  for (let row = rowOf(high, lane); row <= rowOf(low, lane); row += 1) {
    image.pixels[row * image.width + column] = WAVEFORM_LEVEL;
  }
}

function drawMarker(image: GrayImage, cue: AnalysisCue, length: number): void {
  const column = Math.min(image.width - 1, Math.floor((cue.sample * image.width) / length));
  for (let row = 0; row < image.height; row += 1) {
    if (Math.floor(row / DASH_ROWS) % 2 === 0) {
      image.pixels[row * image.width + column] = MARKER_LEVEL;
    }
  }
}

/**
 * A min/max waveform, the left channel in the top lane and the right in the
 * bottom, with a dashed vertical marker in the column of each cue.
 */
export function waveformPixels(
  signal: StereoBuffer,
  cues: readonly AnalysisCue[],
  size: ImageSize
): GrayImage {
  const length = requireStereo(signal);
  for (const cue of cues) {
    requireCueSample(cue, length);
  }
  const image = blankImage(size, 2);
  const topHeight = Math.floor(image.height / 2);
  const lanes = [
    { lane: { top: 0, height: topHeight }, channel: signal.left },
    { lane: { top: topHeight, height: image.height - topHeight }, channel: signal.right },
  ];
  for (let column = 0; column < image.width; column += 1) {
    const [start, end] = columnSamples(column, image.width, length);
    for (const { lane, channel } of lanes) {
      drawColumn(image, column, lane, channel.subarray(start, end));
    }
  }
  for (const cue of cues) {
    drawMarker(image, cue, length);
  }
  return image;
}
