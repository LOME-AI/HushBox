import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { DEFAULT_GL } from '../cli/command.js';
import { exitWhenWritten } from '../cli/run.js';
import { FilmRenderError } from '../render/film-error.js';
import { UnknownFilmError } from '../render/film-module.js';
import { loadFilm } from '../render/films.driver.js';
import { renderFilmStills, renderFilmVideo } from '../render/render-film.driver.js';
import { withRunDirectory } from '../render/run-directory.js';

import { purityGate } from './purity.js';
import { pairPurityFrame } from './purity-pair.driver.js';

import type { PurityFrame } from './purity.js';
import type { GateResult } from './gate.js';

/*
 * The purity comparison over a range of frames, every frame in it a probe
 * frame: the film's one-tab master, rendered in full, against a fresh-page
 * still of each frame in the range. An engine fixture proves its purity here,
 * since `pnpm films verify` refuses a film with no score. Usage, from the
 * repository root:
 *
 *   node --import tsx films/engine/qa/purity.driver.ts <film-id> [--from=0] [--to=59] [--gl=<value>]
 *
 * Exits 0 when every frame matches; 1 naming each differing frame, a frame
 * past the film's end, or a render failure; and 2 for arguments it cannot read,
 * a frame option that is not a whole frame number or a range that runs
 * backwards among them, or an unknown film id.
 */

const USAGE = `usage: node --import tsx films/engine/qa/purity.driver.ts <film-id> [--from=0] [--to=59] [--gl=${DEFAULT_GL}]\n`;

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

interface Options {
  filmId: string;
  frames: number[];
  gl: string;
}

/** A frame option as a whole frame number, or null when it is not one. */
function frameOption(value: string): number | null {
  const frame = Number(value);
  return Number.isInteger(frame) && frame >= 0 ? frame : null;
}

/** The film and the frames the arguments name, or why the arguments could not be read. */
function parseOptions(argv: readonly string[]): Options | { usage: string } {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        from: { type: 'string', default: '0' },
        to: { type: 'string', default: '59' },
        gl: { type: 'string', default: DEFAULT_GL },
      },
    });
  } catch (error) {
    // The options are this module's own constants, so what `parseArgs` refuses is
    // the arguments: an unknown option, or an option missing its value.
    return { usage: String(error) };
  }
  const { positionals, values } = parsed;
  const [filmId] = positionals;
  if (filmId === undefined || positionals.length > 1) {
    return { usage: `purity takes one film id, got ${String(positionals.length)}` };
  }
  const from = frameOption(values.from);
  const to = frameOption(values.to);
  if (from === null || to === null) {
    return {
      usage: `--from and --to must be whole frame numbers, got "${values.from}" and "${values.to}"`,
    };
  }
  if (to < from) {
    return { usage: `--to (${String(to)}) comes before --from (${String(from)})` };
  }
  const frames = Array.from({ length: to - from + 1 }, (_, index) => from + index);
  return { filmId, frames, gl: values.gl };
}

/**
 * Renders the master and the stills into a directory only this run writes, so
 * a command rendering the same piece beside it never hands it its frames, and
 * pairs them frame by frame.
 */
async function purityFrames({ filmId, frames, gl }: Options): Promise<PurityFrame[]> {
  return withRunDirectory(loadFilm(filmId), async (run) => {
    const video = await renderFilmVideo(filmId, {
      draft: false,
      gl,
      probeFrames: frames,
      directory: run,
    });
    const stills = await renderFilmStills(filmId, frames, { gl, directory: run });
    const paired: PurityFrame[] = [];
    for (const [index, frame] of frames.entries()) {
      const file = stills[index];
      paired.push(
        await pairPurityFrame(filmId, {
          frame,
          master: video.probePngs.get(frame),
          still: file === undefined ? undefined : new Uint8Array(readFileSync(file)),
        })
      );
    }
    return paired;
  });
}

function print({ passed, failures, measured }: GateResult, filmId: string): void {
  for (const line of measured) {
    process.stdout.write(`${filmId}: purity: ${line}\n`);
  }
  for (const line of failures) {
    process.stderr.write(`${line}\n`);
  }
  process.stdout.write(`${filmId}: purity: ${passed ? 'PASS' : 'FAIL'}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  let options: Options | { usage: string };
  let result: GateResult;
  try {
    options = parseOptions(argv);
    if ('usage' in options) {
      process.stderr.write(`${options.usage}\n${USAGE}`);
      return EXIT_USAGE;
    }
    result = purityGate(options.filmId, await purityFrames(options));
  } catch (error) {
    if (!(error instanceof FilmRenderError)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n`);
    return error instanceof UnknownFilmError ? EXIT_USAGE : EXIT_FAILED;
  }
  print(result, options.filmId);
  return result.passed ? EXIT_OK : EXIT_FAILED;
}

await exitWhenWritten(await main(process.argv.slice(2)));
