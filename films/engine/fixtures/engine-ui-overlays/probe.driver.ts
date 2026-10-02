import sharp from 'sharp';

import { DEFAULT_GL } from '../../cli/command.js';
import { exitWhenWritten } from '../../cli/run.js';
import { loadFilm } from '../../render/films.driver.js';
import { renderFilmStills } from '../../render/render-film.driver.js';
import { withRunDirectory } from '../../render/run-directory.js';
import { middleOf, TEXTURE_SHIFT } from './timeline.js';

// Renders one frame of each stretch of engine-ui-overlays and checks where its
// popover and dropdown menu land: each shows live when opened, neither shows
// on a hidden frame, and a texture frame is the frame with both open moved down
// by the look's shift, so each overlay appears once, inside the texture. Run
// with `node --import tsx` from the repository root.

const FILM = 'engine-ui-overlays';
/** The largest channel difference read as the same pixel: the browser and the look composite alpha edges apart by a level or two. */
const TOLERANCE = 2;

interface Raster {
  data: Buffer;
  width: number;
  height: number;
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function raster(file: string): Promise<Raster> {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function same(a: Buffer, at: number, b: Buffer, bt: number): boolean {
  for (let channel = 0; channel < 3; channel += 1) {
    if (Math.abs((a[at + channel] ?? 0) - (b[bt + channel] ?? 0)) > TOLERANCE) {
      return false;
    }
  }
  return true;
}

/** The pixels, as offsets, where `a` and `b` differ. */
function differing(a: Raster, b: Raster): number[] {
  const offsets: number[] = [];
  for (let at = 0; at < a.data.length; at += 3) {
    if (!same(a.data, at, b.data, at)) {
      offsets.push(at);
    }
  }
  return offsets;
}

/** The pixels of `texture` that are not `live` moved down by the shift, with the field above it. */
function offShift(texture: Raster, live: Raster, field: Raster): number {
  const row = texture.width * 3;
  let off = 0;
  for (let at = 0; at < texture.data.length; at += 3) {
    const from = at - TEXTURE_SHIFT * row;
    const expected = from >= 0 ? live : field;
    if (!same(texture.data, at, expected.data, from >= 0 ? from : at)) {
      off += 1;
    }
  }
  return off;
}

/** How many of `offsets` in `source` reappear moved down by the shift in `texture`. */
function reappearing(offsets: readonly number[], source: Raster, texture: Raster): number {
  const shift = TEXTURE_SHIFT * texture.width * 3;
  return offsets.filter((at) => same(source.data, at, texture.data, at + shift)).length;
}

async function main(): Promise<boolean> {
  const ids = ['closed', 'popover', 'menu', 'both', 'hidden', 'texture'] as const;
  const frames = ids.map((id) => middleOf(id));
  // The stills render into this run's own directory, so no other command on the piece hands it a frame.
  const [closed, popover, menu, both, hidden, texture] = await withRunDirectory(
    loadFilm(FILM),
    async (run) => {
      const files = await renderFilmStills(FILM, frames, { gl: DEFAULT_GL, directory: run });
      return Promise.all(files.map(async (file) => raster(file)));
    }
  );
  if (!closed || !popover || !menu || !both || !hidden || !texture) {
    throw new Error(`${FILM}: a still did not load`);
  }
  const field: Raster = { ...hidden, data: Buffer.alloc(hidden.data.length) };
  for (let at = 0; at < field.data.length; at += 3) {
    closed.data.copy(field.data, at, 0, 3);
  }
  const popoverPixels = differing(popover, closed);
  const menuPixels = differing(menu, closed);
  const hiddenShown = differing(hidden, field).length;
  const lowRows = both.data.length - TEXTURE_SHIFT * both.width * 3;
  const clipped = differing(both, field).filter((at) => at >= lowRows).length;
  const textureOff = offShift(texture, both, field);
  const popoverMoved = reappearing(popoverPixels, popover, texture);
  const menuMoved = reappearing(menuPixels, menu, texture);
  const checks = [
    {
      name: 'the popover shows live when opened',
      pixels: popoverPixels.length,
      passed: popoverPixels.length > 0,
    },
    {
      name: 'the menu shows live when opened',
      pixels: menuPixels.length,
      passed: menuPixels.length > 0,
    },
    {
      name: 'a hidden frame shows nothing but the field',
      pixels: hiddenShown,
      passed: hiddenShown === 0,
    },
    { name: 'the shift keeps the whole UI in frame', pixels: clipped, passed: clipped === 0 },
    {
      name: 'the texture frame is the open frame moved down, and nothing else',
      pixels: textureOff,
      passed: textureOff === 0,
    },
    {
      name: "the popover's pixels reappear moved down in the texture",
      pixels: popoverMoved,
      passed: popoverMoved === popoverPixels.length,
    },
    {
      name: "the menu's pixels reappear moved down in the texture",
      pixels: menuMoved,
      passed: menuMoved === menuPixels.length,
    },
  ];
  for (const { name, pixels, passed } of checks) {
    print(`${FILM}: ${passed ? 'pass' : 'FAIL'}: ${name} (${String(pixels)} pixels)`);
  }
  return checks.every(({ passed }) => passed);
}

await exitWhenWritten((await main()) ? 0 : 1);
