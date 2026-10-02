import sharp from 'sharp';

import { DEFAULT_GL } from '../../cli/command.js';
import { exitWhenWritten } from '../../cli/run.js';
import { loadFilm } from '../../render/films.driver.js';
import { renderFilmStills } from '../../render/render-film.driver.js';
import { withRunDirectory } from '../../render/run-directory.js';
import { DRAWN_PREFIX } from './engine-look-plain/look.js';

// Renders one frame of the plain look (post chain off) and of its control (the
// same look with the post chain on at every effect 0), and compares each still
// byte for byte with the RGBA the look drew into its own canvas, read back as
// the PNG the look writes to the console. Passes when the plain frame matches
// and the control does not. Run with `node --import tsx` from the repository root.

const FRAME = 30;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function rgba(png: Uint8Array): Promise<Buffer> {
  return sharp(png).ensureAlpha().raw().toBuffer();
}

/** How many RGBA bytes of the rendered frame differ from the look's own canvas. */
async function differingBytes(filmId: string): Promise<number> {
  let drawn: string | undefined;
  // The still renders into this run's own directory, so no other command on the piece hands it a frame.
  const png = await withRunDirectory(loadFilm(filmId), async (run) => {
    const [file] = await renderFilmStills(filmId, [FRAME], {
      gl: DEFAULT_GL,
      directory: run,
      onBrowserLog: (line) => {
        const [prefix, frame, url] = line.split(' ');
        if (prefix === DRAWN_PREFIX && Number(frame) === FRAME) {
          drawn = url;
        }
      },
    });
    if (file === undefined) {
      throw new Error(`${filmId}: frame ${String(FRAME)} rendered no still`);
    }
    return sharp(file).png().toBuffer();
  });
  if (drawn === undefined) {
    throw new Error(`${filmId}: frame ${String(FRAME)} wrote no ${DRAWN_PREFIX} line`);
  }
  const canvas = await rgba(Buffer.from(drawn.slice(drawn.indexOf(',') + 1), 'base64'));
  const still = await rgba(png);
  if (canvas.length !== still.length) {
    throw new Error(`${filmId}: the canvas and the still differ in size`);
  }
  let differing = 0;
  for (const [index, canva] of canvas.entries()) {
    if (canva !== still[index]) {
      differing += 1;
    }
  }
  print(
    `${filmId}: frame ${String(FRAME)}: ${String(differing)} of ${String(canvas.length)} RGBA bytes differ from the look's own canvas`
  );
  return differing;
}

const plain = await differingBytes('engine-look-plain');
const finished = await differingBytes('engine-look-finished');
const passed = plain === 0 && finished > 0;
print(
  passed
    ? 'post chain off: the frame is the look’s pixels; post chain on: the finish moves them'
    : 'the plain frame moved off the look’s pixels, or the finished frame did not'
);
await exitWhenWritten(passed ? 0 : 1);
