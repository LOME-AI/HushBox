import path from 'node:path';

import { ScoreError } from '../audio/score/index.js';
import { FilmSpecError } from '../film/spec.js';
import { FilmRenderError } from '../render/film-error.js';
import { UnknownFilmError } from '../render/film-module.js';
import { QaGateError } from '../qa/gate.js';

import { USAGE, parseCommand } from './command.js';

export interface StillsOptions {
  /** The frames to render, or null for the film's probe frames. */
  frames: number[] | null;
  gl: string;
}

export interface RenderOptions {
  draft: boolean;
  gl: string;
}

export interface VerifyOptions {
  gl: string;
}

export interface TakeOptions {
  gl: string;
}

/** What each verb does to a film by id, or to a take by path; each returns the files it wrote. */
export interface FilmVerbs {
  score(filmId: string): Promise<string[]>;
  stills(filmId: string, options: StillsOptions): Promise<string[]>;
  render(filmId: string, options: RenderOptions): Promise<string[]>;
  verify(filmId: string, options: VerifyOptions): Promise<string[]>;
  take(takePath: string, options: TakeOptions): Promise<string[]>;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

/** A failure whose message already names the film, the rule and what broke. */
function isNamedFailure(error: unknown): error is Error {
  return (
    error instanceof FilmRenderError ||
    error instanceof ScoreError ||
    error instanceof FilmSpecError ||
    error instanceof QaGateError
  );
}

async function dispatch(argv: readonly string[], verbs: FilmVerbs): Promise<string[] | number> {
  const parsed = parseCommand(argv);
  if ('usage' in parsed) {
    process.stderr.write(`${parsed.usage}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { command } = parsed;
  switch (command.verb) {
    case 'score': {
      return verbs.score(command.filmId);
    }
    case 'stills': {
      return verbs.stills(command.filmId, { frames: command.frames, gl: command.gl });
    }
    case 'render': {
      return verbs.render(command.filmId, { draft: command.draft, gl: command.gl });
    }
    case 'verify': {
      return verbs.verify(command.filmId, { gl: command.gl });
    }
    case 'take': {
      return verbs.take(command.takePath, { gl: command.gl });
    }
  }
}

/**
 * Runs `pnpm films <verb> <film> [options]` and returns its exit status: 0 with
 * each written file printed relative to the working directory, 2 for arguments it cannot read or a film id no film
 * declares, 1 for a failure with a named cause. Any other failure is a defect
 * and is rethrown.
 */
export async function runCli(argv: readonly string[], verbs: FilmVerbs): Promise<number> {
  let outcome: string[] | number;
  try {
    outcome = await dispatch(argv, verbs);
  } catch (error) {
    if (!isNamedFailure(error)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n`);
    return error instanceof UnknownFilmError ? EXIT_USAGE : EXIT_FAILED;
  }
  if (typeof outcome === 'number') {
    return outcome;
  }
  for (const file of outcome) {
    process.stdout.write(`${path.relative(process.cwd(), file)}\n`);
  }
  return EXIT_OK;
}

/** Resolves once `stream` has written everything handed to it before this call. */
async function written(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => {
      resolve();
    });
  });
}

/**
 * Ends the process with `code` once stdout and stderr have written everything:
 * a pipe writes asynchronously, and exiting before it drains would cut the
 * output short. Exiting, rather than waiting for the event loop to empty, is
 * what runs the exit hook Remotion gives every browser it opens, so a browser
 * it replaced mid-render, which no caller holds, is killed with the process.
 */
export async function exitWhenWritten(code: number): Promise<never> {
  await written(process.stdout);
  await written(process.stderr);
  // eslint-disable-next-line unicorn/no-process-exit -- this is the films CLI's own exit, run once its output is written; an explicit exit is what fires the exit hook that kills a browser Remotion opened and no caller holds.
  process.exit(code);
}
