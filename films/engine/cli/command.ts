import { parseArgs } from 'node:util';

import type { ParseArgsOptionsConfig } from 'node:util';

/** The GL backend every rendering verb uses unless `--gl` names another. */
export const DEFAULT_GL = 'angle';

export const USAGE = [
  'usage: pnpm films <score|stills|render|verify|take> <film|take-path> [options]',
  '  score <film>                                  master WAV, stems, audio report and pictures',
  '  stills <film> [--frames a,b,c] [--gl <value>] probe stills and a contact sheet',
  '  render <film> [--draft] [--gl <value>]        score, then the delivered MP4',
  '  verify <film> [--gl <value>]                  render, run every gate, write the report',
  '  take <take-path> [--gl <value>]               the take MP4, master, beat stills, sheet, cue strips; no gate',
  '',
].join('\n');

export type Command =
  | { verb: 'score'; filmId: string }
  | { verb: 'stills'; filmId: string; frames: number[] | null; gl: string }
  | { verb: 'render'; filmId: string; draft: boolean; gl: string }
  | { verb: 'verify'; filmId: string; gl: string }
  | { verb: 'take'; takePath: string; gl: string };

/** Why the arguments could not be read. */
interface Usage {
  usage: string;
}

/** A command read from the arguments, or why it could not be read. */
export type Parsed = { command: Command } | Usage;

const WHOLE_FRAME = /^\d+$/;

const GL_OPTION = { type: 'string', default: DEFAULT_GL } as const;

/** What a verb's one positional argument names. */
function subjectOf(verb: Command['verb']): string {
  return verb === 'take' ? 'take path' : 'film id';
}

/** A verb's options and its one film id (a take path for `take`), or why they could not be read. */
function readArgs<T extends ParseArgsOptionsConfig>(
  verb: Command['verb'],
  rest: readonly string[],
  options: T
):
  | {
      filmId: string;
      values: ReturnType<
        typeof parseArgs<{ options: T; strict: true; allowPositionals: true }>
      >['values'];
    }
  | Usage {
  let parsed;
  try {
    parsed = parseArgs({ args: [...rest], options, allowPositionals: true, strict: true });
  } catch (error) {
    // The options are this module's own constants, so what `parseArgs` refuses is
    // the arguments: an unknown option, or an option missing its value.
    return { usage: String(error) };
  }
  const [filmId] = parsed.positionals;
  if (filmId === undefined) {
    return { usage: `${verb} needs a ${subjectOf(verb)}` };
  }
  if (parsed.positionals.length > 1) {
    const count = String(parsed.positionals.length);
    return { usage: `${verb} takes one ${subjectOf(verb)}, got ${count}` };
  }
  return { filmId, values: parsed.values };
}

/** The frames `--frames` lists, null when it is absent, or why the list could not be read. */
function parseFrames(list: string | undefined): { frames: number[] | null } | Usage {
  if (list === undefined) {
    return { frames: null };
  }
  const entries = list.split(',');
  const bad = entries.find((entry) => !WHOLE_FRAME.test(entry));
  if (bad !== undefined) {
    return { usage: `--frames takes whole frame numbers separated by commas, got "${bad}"` };
  }
  return { frames: entries.map(Number) };
}

function parseStills(rest: readonly string[]): Parsed {
  const args = readArgs('stills', rest, { frames: { type: 'string' }, gl: GL_OPTION });
  if ('usage' in args) {
    return args;
  }
  const parsed = parseFrames(args.values.frames);
  if ('usage' in parsed) {
    return parsed;
  }
  return {
    command: { verb: 'stills', filmId: args.filmId, frames: parsed.frames, gl: args.values.gl },
  };
}

function parseRender(rest: readonly string[]): Parsed {
  const args = readArgs('render', rest, {
    draft: { type: 'boolean', default: false },
    gl: GL_OPTION,
  });
  if ('usage' in args) {
    return args;
  }
  const { draft, gl } = args.values;
  return { command: { verb: 'render', filmId: args.filmId, draft, gl } };
}

function parseVerify(rest: readonly string[]): Parsed {
  const args = readArgs('verify', rest, { gl: GL_OPTION });
  return 'usage' in args
    ? args
    : { command: { verb: 'verify', filmId: args.filmId, gl: args.values.gl } };
}

function parseTake(rest: readonly string[]): Parsed {
  const args = readArgs('take', rest, { gl: GL_OPTION });
  return 'usage' in args
    ? args
    : { command: { verb: 'take', takePath: args.filmId, gl: args.values.gl } };
}

function parseScore(rest: readonly string[]): Parsed {
  const args = readArgs('score', rest, {});
  return 'usage' in args ? args : { command: { verb: 'score', filmId: args.filmId } };
}

/** Reads `pnpm films <verb> <film> [options]`; anything it cannot read comes back as a usage reason. */
export function parseCommand(argv: readonly string[]): Parsed {
  const [verb, ...rest] = argv;
  switch (verb) {
    case undefined: {
      return { usage: 'no verb was given' };
    }
    case 'score': {
      return parseScore(rest);
    }
    case 'stills': {
      return parseStills(rest);
    }
    case 'render': {
      return parseRender(rest);
    }
    case 'verify': {
      return parseVerify(rest);
    }
    case 'take': {
      return parseTake(rest);
    }
    default: {
      return { usage: `unknown verb "${verb}"` };
    }
  }
}
