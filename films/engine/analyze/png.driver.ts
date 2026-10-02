import sharp from 'sharp';

import { spectrogramPixels } from './spectrogram.js';
import { waveformPixels } from './waveform.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { GrayImage, ImageSize } from './image.js';
import type { AnalysisCue } from './signal.js';

/** A greyscale picture as PNG bytes; libvips writes no timestamp or other varying metadata. */
async function encodePng(image: GrayImage): Promise<Buffer> {
  return sharp(image.pixels, { raw: { width: image.width, height: image.height, channels: 1 } })
    .toColourspace('b-w')
    .png()
    .toBuffer();
}

/** The log-frequency spectrogram of a signal as a PNG. */
export async function spectrogramPng(signal: StereoBuffer, size: ImageSize): Promise<Buffer> {
  return encodePng(spectrogramPixels(signal, size));
}

/** The waveform of a signal, with a marker at each cue, as a PNG. */
export async function waveformPng(
  signal: StereoBuffer,
  cues: readonly AnalysisCue[],
  size: ImageSize
): Promise<Buffer> {
  return encodePng(waveformPixels(signal, cues, size));
}
