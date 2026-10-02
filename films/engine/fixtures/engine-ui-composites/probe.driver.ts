import sharp from 'sharp';

import { DEFAULT_GL } from '../../cli/command.js';
import { exitWhenWritten } from '../../cli/run.js';
import { loadFilm } from '../../render/films.driver.js';
import { renderFilmStills } from '../../render/render-film.driver.js';
import { withRunDirectory } from '../../render/run-directory.js';
import { frameInside, TEXTURE_DROP } from './timeline.js';

import type { Beat } from './timeline.js';

// Renders the middle frame of each beat of engine-ui-composites and checks
// where the app's Menu, Overlay-router dialog and sheet land when none is
// given a container: each shows live as it opens, none shows on the hidden
// frame, and on a texture frame each is drawn once, inside the texture the
// look drops by its shift, and nowhere live. Run with `node --import tsx` from
// the repository root.

const FILM = 'engine-ui-composites';
/** The largest channel difference still read as one colour: the browser and the look round alpha edges apart by a level or two. */
const LEVELS = 2;

/** One still as packed RGB rows. */
interface Still {
  rgb: Buffer;
  rowBytes: number;
}

/** A rectangle of the frame, its edges inclusive, in rows and columns. */
interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

async function decode(file: string): Promise<Still> {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { rgb: data, rowBytes: info.width * 3 };
}

/** Whether the pixel at byte `a` of `left` and at byte `b` of `right` read as one colour. */
function alike(left: Buffer, a: number, right: Buffer, b: number): boolean {
  return [0, 1, 2].every(
    (channel) => Math.abs((left[a + channel] ?? 0) - (right[b + channel] ?? 0)) <= LEVELS
  );
}

/** The byte offsets of every pixel of `still` that fails `keep`. */
function failing(still: Still, keep: (at: number) => boolean): number[] {
  const offsets: number[] = [];
  for (let at = 0; at < still.rgb.length; at += 3) {
    if (!keep(at)) {
      offsets.push(at);
    }
  }
  return offsets;
}

/** The smallest box holding every one of `offsets`. */
function boxAround(offsets: readonly number[], rowBytes: number): Box {
  const rows = offsets.map((at) => Math.floor(at / rowBytes));
  const columns = offsets.map((at) => (at % rowBytes) / 3);
  return {
    top: Math.min(...rows),
    bottom: Math.max(...rows),
    left: Math.min(...columns),
    right: Math.max(...columns),
  };
}

function inside(box: Box, at: number, rowBytes: number): boolean {
  const row = Math.floor(at / rowBytes);
  const column = (at % rowBytes) / 3;
  return row >= box.top && row <= box.bottom && column >= box.left && column <= box.right;
}

/** A check's name, its pixel count, and whether it passes on some pixels or on none. */
interface Check {
  name: string;
  pixels: number;
  want: 'some' | 'none';
}

const ORDER: readonly Beat['id'][] = [
  'closed',
  'menu',
  'menu-texture',
  'dialog',
  'sheet',
  'hidden',
  'texture',
];

/** Renders the middle frame of every beat as a fresh-page still; returns a reader of each by its beat. */
async function renderStills(): Promise<(id: Beat['id']) => Still> {
  const frames = ORDER.map((id) => frameInside(id));
  // The stills render into this run's own directory, so no other command on the piece hands it a frame.
  const stills = await withRunDirectory(loadFilm(FILM), async (run) => {
    const files = await renderFilmStills(FILM, frames, { gl: DEFAULT_GL, directory: run });
    return new Map(
      await Promise.all(
        ORDER.map(async (id, index) => {
          const file = files[index];
          if (file === undefined) {
            throw new Error(`${FILM}: beat ${id} rendered no still`);
          }
          return [id, await decode(file)] as const;
        })
      )
    );
  });
  return (id) => {
    const still = stills.get(id);
    if (still === undefined) {
      throw new Error(`${FILM}: the still of beat ${id} did not load`);
    }
    return still;
  };
}

/** Prints every check and returns whether all passed. */
function report(checks: readonly Check[]): boolean {
  let passed = true;
  for (const { name, pixels, want } of checks) {
    const ok = want === 'some' ? pixels > 0 : pixels === 0;
    passed &&= ok;
    process.stdout.write(`${FILM}: ${ok ? 'pass' : 'FAIL'}: ${name} (${String(pixels)} pixels)\n`);
  }
  return passed;
}

async function main(): Promise<boolean> {
  const stillOf = await renderStills();
  const closed = stillOf('closed');
  const menu = stillOf('menu');
  const menuTexture = stillOf('menu-texture');
  const dialog = stillOf('dialog');
  const sheet = stillOf('sheet');
  const hidden = stillOf('hidden');
  const texture = stillOf('texture');
  const { rowBytes } = closed;
  const drop = TEXTURE_DROP * rowBytes;
  /** The field's colour: the closed frame's first pixel, which no composite covers. */
  const isField = (still: Still, at: number): boolean => alike(still.rgb, at, closed.rgb, 0);
  const changed = (before: Still, after: Still): number[] =>
    failing(after, (at) => alike(after.rgb, at, before.rgb, at));
  /** Whether `frame` is the field above the drop and `live` dropped below it. */
  const droppedFrom =
    (frame: Still, live: Still) =>
    (at: number): boolean =>
      at < drop ? isField(frame, at) : alike(frame.rgb, at, live.rgb, at - drop);
  // The Menu composite's own box, its trigger and its open list: everything
  // the closed frame draws over the field, and everything opening it changes.
  const menuPixels = changed(closed, menu);
  const menuBox = boxAround(
    [...failing(closed, (at) => isField(closed, at)), ...menuPixels],
    rowBytes
  );
  const offTexture = failing(texture, droppedFrom(texture, sheet));
  const offOutsideMenu = offTexture.filter(
    (at) => at < drop || !inside(menuBox, at - drop, rowBytes)
  );
  const lastPixel = sheet.rgb.length - 3;
  const passed = report([
    { name: 'the menu shows live as it opens', pixels: menuPixels.length, want: 'some' },
    {
      name: 'the dialog shows live as it opens',
      pixels: changed(menu, dialog).length,
      want: 'some',
    },
    {
      name: 'the sheet shows live as it opens',
      pixels: changed(dialog, sheet).length,
      want: 'some',
    },
    {
      name: 'a hidden frame shows nothing but the field',
      pixels: failing(hidden, (at) => isField(hidden, at)).length,
      want: 'none',
    },
    {
      name: 'the menu lies wholly above the drop',
      pixels: menuPixels.filter((at) => at >= menu.rgb.length - drop).length,
      want: 'none',
    },
    {
      name: 'the menu texture frame is the field over the open-menu frame dropped, and nothing else',
      pixels: failing(menuTexture, droppedFrom(menuTexture, menu)).length,
      want: 'none',
    },
    {
      name: 'below the drop the all-open frame holds nothing but one colour of scrim',
      pixels: failing(
        sheet,
        (at) => at < sheet.rgb.length - drop || alike(sheet.rgb, at, sheet.rgb, lastPixel)
      ).length,
      want: 'none',
    },
    {
      name: 'the texture frame is the field over the all-open frame dropped, outside the Menu composite',
      pixels: offOutsideMenu.length,
      want: 'none',
    },
  ]);
  // The dialog's scrim blurs what lies under it; over the Menu composite the
  // live frame and the UI pass draw that blur apart, which the texture check
  // above leaves out and this line reports.
  process.stdout.write(
    `${FILM}: note: the texture frame differs from the all-open frame dropped inside the Menu composite's box (${String(offTexture.length - offOutsideMenu.length)} pixels)\n`
  );
  return passed;
}

await exitWhenWritten((await main()) ? 0 : 1);
