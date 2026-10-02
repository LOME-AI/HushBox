import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { RenderInternals } from '@remotion/renderer';
import sharp from 'sharp';

import { muxArguments } from '../render/ffmpeg-args.js';
import { FilmRenderError } from '../render/film-error.js';

import { blockMeans, colourScoreOfMeans } from './colour.js';
import { colourChart } from './colour-chart.js';
import { forEachDecodedFrame } from './decode.driver.js';

import type { MuxOptions } from '../render/ffmpeg-args.js';

/** The bundled ffmpeg's arguments for a delivered MP4: the delivery's own, or a control's alteration of them. */
export type Mux = (options: MuxOptions) => string[];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Encodes PNG frames, in order, to a picture-only MP4 at `output` through the bundled ffmpeg under `mux`. */
export async function encodePngs(
  filmId: string,
  pngs: readonly Uint8Array[],
  output: string,
  mux: Mux = muxArguments
): Promise<void> {
  mkdirSync(path.dirname(output), { recursive: true });
  try {
    await RenderInternals.callFf({
      bin: 'ffmpeg',
      args: mux({ frameFormat: 'png', audio: null, output }),
      indent: false,
      logLevel: 'error',
      binariesDirectory: null,
      cancelSignal: undefined,
      options: { input: Buffer.concat(pngs) },
    });
  } catch (error) {
    throw new FilmRenderError(
      { filmId, rule: 'mux', detail: `the bundled ffmpeg failed: ${messageOf(error)}` },
      { cause: error }
    );
  }
}

/**
 * The colour chart's block-mean PSNR against itself after the delivery's encode
 * under `mux` and the decode as tagged, its MP4 written in `directory`.
 */
export async function chartColour(
  filmId: string,
  directory: string,
  mux: Mux = muxArguments
): Promise<number> {
  const chart = colourChart();
  const { width, height, channels } = chart;
  const png = await sharp(chart.data, { raw: { width, height, channels } }).png().toBuffer();
  const file = path.join(directory, 'colour-chart.mp4');
  await encodePngs(filmId, [new Uint8Array(png)], file, mux);
  const scores: number[] = [];
  const stillMeans = blockMeans(chart);
  await forEachDecodedFrame(filmId, file, 'rgb24', (index, frame) => {
    const decoded = blockMeans({ width, height, channels, data: frame });
    scores.push(colourScoreOfMeans(index, decoded, stillMeans).psnr);
  });
  const [psnr] = scores;
  if (scores.length !== 1 || psnr === undefined) {
    throw new FilmRenderError({
      filmId,
      rule: 'decode',
      detail: `the colour chart's MP4 decoded to ${String(scores.length)} frames, not 1`,
    });
  }
  return psnr;
}
