import { createRequire } from 'node:module';

import sharp from 'sharp';

import { DEFAULT_GL } from '../../cli/command.js';
import { exitWhenWritten } from '../../cli/run.js';
import { loadFilm } from '../../render/films.driver.js';
import { renderFilmStills } from '../../render/render-film.driver.js';
import { withRunDirectory } from '../../render/run-directory.js';
import { definition, SETTLE_FRAME } from './film.js';
import { IMAGE_AT, MARK_AT } from './look.js';

// Renders frames of engine-logo and reads two regions of each still. Where the
// look draws the decoded logo file at 1:1, every byte must equal the file
// composited over the field. Where the traced mark flies in, the pixels nearer
// the fill colour than the field must match the file's opaque pixels to 0.995
// intersection over union from the settle frame on, and must not before it.
// Run with `node --import tsx` from the repository root.

const BOUND = 0.995;
const LAST = definition.spec.durationInFrames - 1;
const FRAMES = [0, Math.floor(SETTLE_FRAME / 2), SETTLE_FRAME, LAST];

interface Raster {
  width: number;
  height: number;
  data: Buffer;
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function raster(input: string | Buffer): Promise<Raster> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function rgbAt(image: Raster, x: number, y: number): [number, number, number] {
  const at = (y * image.width + x) * 4;
  return [image.data[at] ?? 0, image.data[at + 1] ?? 0, image.data[at + 2] ?? 0];
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt(a.reduce((sum, value, index) => sum + (value - (b[index] ?? 0)) ** 2, 0));
}

/** Bytes of the still's region at `at` that differ from the file over the field colour. */
function imageDifferences(still: Raster, logo: Raster, field: readonly number[]): number {
  let differing = 0;
  for (let y = 0; y < logo.height; y += 1) {
    for (let x = 0; x < logo.width; x += 1) {
      const opaque = (logo.data[(y * logo.width + x) * 4 + 3] ?? 0) === 255;
      const expected = opaque ? rgbAt(logo, x, y) : field;
      const drawn = rgbAt(still, IMAGE_AT.x + x, IMAGE_AT.y + y);
      differing += drawn.filter((value, channel) => value !== expected[channel]).length;
    }
  }
  return differing;
}

/** The commonest colour in the mark's region other than the field: the colour its parts fill with. */
function fillColour(still: Raster, logo: Raster, field: readonly number[]): readonly number[] {
  const counts = new Map<string, number>();
  for (let y = 0; y < logo.height; y += 1) {
    for (let x = 0; x < logo.width; x += 1) {
      const colour = rgbAt(still, MARK_AT.x + x, MARK_AT.y + y);
      if (distance(colour, field) > 0) {
        const key = colour.join(',');
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const [commonest] = [...counts.entries()].toSorted((a, b) => b[1] - a[1]);
  return commonest === undefined ? field : commonest[0].split(',').map(Number);
}

/** Intersection over union of the mark region's filled pixels and the file's opaque ones. */
function markIou(still: Raster, logo: Raster, field: readonly number[]): number {
  const fill = fillColour(still, logo, field);
  let both = 0;
  let either = 0;
  for (let y = 0; y < logo.height; y += 1) {
    for (let x = 0; x < logo.width; x += 1) {
      const colour = rgbAt(still, MARK_AT.x + x, MARK_AT.y + y);
      const drawn = distance(colour, fill) < distance(colour, field);
      const opaque = (logo.data[(y * logo.width + x) * 4 + 3] ?? 0) >= 128;
      both += drawn && opaque ? 1 : 0;
      either += drawn || opaque ? 1 : 0;
    }
  }
  return both / either;
}

const logo = await raster(
  createRequire(import.meta.url).resolve('@hushbox/ui/assets/HushBoxLogo.png')
);
// The stills render into this run's own directory, so no other command on the piece hands it a frame.
const stills = await withRunDirectory(loadFilm('engine-logo'), async (run) => {
  const files = await renderFilmStills('engine-logo', FRAMES, { gl: DEFAULT_GL, directory: run });
  return Promise.all(files.map(async (file) => raster(file)));
});
let passed = true;
for (const [index, still] of stills.entries()) {
  const frame = FRAMES[index] ?? 0;
  const field = rgbAt(still, 0, 0);
  const differing = imageDifferences(still, logo, field);
  const iou = markIou(still, logo, field);
  const settled = frame >= SETTLE_FRAME;
  const ok = differing === 0 && (settled ? iou >= BOUND : iou < BOUND);
  passed &&= ok;
  print(
    `engine-logo: frame ${String(frame)}: ${String(differing)} bytes of the 1:1 logo differ from the file; traced mark IoU ${iou.toFixed(5)} (${settled ? 'settled' : 'in flight'}) ${ok ? 'ok' : 'FAIL'}`
  );
}
await exitWhenWritten(passed ? 0 : 1);
