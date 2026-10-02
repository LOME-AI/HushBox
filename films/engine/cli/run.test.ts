import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScoreError } from '../audio/score/index.js';
import { FilmSpecError } from '../film/spec.js';
import { FilmRenderError } from '../render/film-error.js';
import { UnknownFilmError } from '../render/film-module.js';
import { QaGateError, gateResult } from '../qa/gate.js';

import { exitWhenWritten, runCli } from './run.js';

import type { MockInstance } from 'vitest';
import type { FilmVerbs, RenderOptions, StillsOptions, TakeOptions, VerifyOptions } from './run.js';

let stdout: MockInstance<typeof process.stdout.write>;
let stderr: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
});

function written(spy: MockInstance<typeof process.stdout.write>): string {
  return spy.mock.calls.map(([chunk]) => String(chunk)).join('');
}

/** Verbs that record what they were asked and write the given paths, or fail with `failure`. */
function recordingVerbs(options: { wrote?: string[]; failure?: Error } = {}): FilmVerbs & {
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const act = (...args: unknown[]): Promise<string[]> => {
    calls.push(args);
    return options.failure === undefined
      ? Promise.resolve(options.wrote ?? [])
      : Promise.reject(options.failure);
  };
  return {
    calls,
    score: (filmId: string): Promise<string[]> => act('score', filmId),
    stills: (filmId: string, stillsOptions: StillsOptions): Promise<string[]> =>
      act('stills', filmId, stillsOptions),
    render: (filmId: string, renderOptions: RenderOptions): Promise<string[]> =>
      act('render', filmId, renderOptions),
    verify: (filmId: string, verifyOptions: VerifyOptions): Promise<string[]> =>
      act('verify', filmId, verifyOptions),
    take: (takePath: string, takeOptions: TakeOptions): Promise<string[]> =>
      act('take', takePath, takeOptions),
  };
}

describe('runCli', () => {
  it('prints the reason and the usage for a command it cannot read', async () => {
    await runCli(['dance'], recordingVerbs());

    expect(written(stderr)).toMatch(
      /^unknown verb "dance"\nusage: pnpm films <score\|stills\|render\|verify\|take>/
    );
  });

  it('exits 2 for a command it cannot read', async () => {
    expect(await runCli(['dance'], recordingVerbs())).toBe(2);
  });

  it('runs verify with the GL backend given', async () => {
    const verbs = recordingVerbs();
    await runCli(['verify', 'engine-render', '--gl', 'swangle'], verbs);

    expect(verbs.calls).toEqual([['verify', 'engine-render', { gl: 'swangle' }]]);
  });

  it('prints every failure line of a film that failed its gates', async () => {
    const failure = new QaGateError('engine-render', [
      gateResult(
        'purity',
        [{ filmId: 'engine-render', rule: 'purity', at: 'frame 48', detail: 'differs' }],
        []
      ),
    ]);
    await runCli(['verify', 'engine-render'], recordingVerbs({ failure }));

    expect(written(stderr)).toBe(
      'engine-render: verify failed: purity\nengine-render: purity: frame 48: differs\n'
    );
  });

  it('exits 1 for a film that failed its gates', async () => {
    const failure = new QaGateError('engine-render', [
      gateResult(
        'purity',
        [{ filmId: 'engine-render', rule: 'purity', at: 'frame 48', detail: 'differs' }],
        []
      ),
    ]);

    expect(await runCli(['verify', 'engine-render'], recordingVerbs({ failure }))).toBe(1);
  });

  it('runs score on the film named', async () => {
    const verbs = recordingVerbs();
    await runCli(['score', 'engine-render'], verbs);

    expect(verbs.calls).toEqual([['score', 'engine-render']]);
  });

  it('runs stills with the frames and GL backend given', async () => {
    const verbs = recordingVerbs();
    await runCli(['stills', 'engine-render', '--frames', '0,24', '--gl', 'swangle'], verbs);

    expect(verbs.calls).toEqual([['stills', 'engine-render', { frames: [0, 24], gl: 'swangle' }]]);
  });

  it('runs render with the draft switch and GL backend given', async () => {
    const verbs = recordingVerbs();
    await runCli(['render', 'engine-render', '--draft'], verbs);

    expect(verbs.calls).toEqual([['render', 'engine-render', { draft: true, gl: 'angle' }]]);
  });

  it('runs take on the take path with the GL backend given', async () => {
    const verbs = recordingVerbs();
    await runCli(['take', 'my-film/rounds/01/ink', '--gl', 'swangle'], verbs);

    expect(verbs.calls).toEqual([['take', 'my-film/rounds/01/ink', { gl: 'swangle' }]]);
  });

  it('prints each file a verb wrote, one to a line', async () => {
    await runCli(['score', 'engine-render'], recordingVerbs({ wrote: ['a.wav', 'b.json'] }));

    expect(written(stdout)).toBe('a.wav\nb.json\n');
  });

  it('prints each file relative to the working directory', async () => {
    const file = path.join(process.cwd(), 'out', 'engine-render.mp4');
    await runCli(['score', 'engine-render'], recordingVerbs({ wrote: [file] }));

    expect(written(stdout)).toBe(`${path.join('out', 'engine-render.mp4')}\n`);
  });

  it('exits 0 when the verb succeeds', async () => {
    expect(await runCli(['score', 'engine-render'], recordingVerbs())).toBe(0);
  });

  it('prints an unknown film id with the known ids', async () => {
    const failure = new UnknownFilmError('engine-rendr', ['engine-empty', 'engine-render']);
    await runCli(['score', 'engine-rendr'], recordingVerbs({ failure }));

    expect(written(stderr)).toBe(`${failure.message}\n`);
  });

  it('exits 2 for an unknown film id', async () => {
    const failure = new UnknownFilmError('engine-rendr', ['engine-render']);

    expect(await runCli(['score', 'engine-rendr'], recordingVerbs({ failure }))).toBe(2);
  });

  it('prints a render failure by its named cause', async () => {
    const failure = new FilmRenderError({
      filmId: 'engine-render',
      rule: 'render',
      detail: 'frame 49 did not render within 60 s',
    });
    await runCli(['render', 'engine-render'], recordingVerbs({ failure }));

    expect(written(stderr)).toBe('engine-render: render: frame 49 did not render within 60 s\n');
  });

  it('exits 1 for a render failure', async () => {
    const failure = new FilmRenderError({ filmId: 'engine-render', rule: 'mux', detail: 'x' });

    expect(await runCli(['render', 'engine-render'], recordingVerbs({ failure }))).toBe(1);
  });

  it('exits 1 for a score the film refuses', async () => {
    const failure = new ScoreError({
      filmId: 'engine-render',
      rule: 'unknown-cue',
      subject: 'track "click" event 0',
      detail: 'names cue "nope"',
    });

    expect(await runCli(['score', 'engine-render'], recordingVerbs({ failure }))).toBe(1);
  });

  it('exits 1 for a film spec that breaks a load-time rule', async () => {
    const failure = new FilmSpecError({
      filmId: 'engine-render',
      rule: 'shots-tile',
      subject: 'shot "a"',
      detail: 'gap',
    });

    expect(await runCli(['score', 'engine-render'], recordingVerbs({ failure }))).toBe(1);
  });

  it('rethrows a failure with no named cause', async () => {
    const failure = new TypeError('a defect');

    await expect(runCli(['score', 'engine-render'], recordingVerbs({ failure }))).rejects.toBe(
      failure
    );
  });
});

/** Stands in for the process exiting, which a test cannot let happen. */
class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`exit ${String(code)}`);
  }
}

describe('exitWhenWritten', () => {
  it('exits with the code once stdout and stderr have written everything before it', async () => {
    const order: string[] = [];
    const flushing =
      (stream: string) =>
      (_chunk: unknown, done?: unknown): boolean => {
        order.push(stream);
        if (typeof done === 'function') Reflect.apply(done, undefined, []);
        return true;
      };
    stdout.mockImplementation(flushing('stdout'));
    stderr.mockImplementation(flushing('stderr'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      order.push(`exit ${String(code)}`);
      throw new ExitCalled(code);
    });
    try {
      await expect(exitWhenWritten(2)).rejects.toBeInstanceOf(ExitCalled);

      expect(order).toEqual(['stdout', 'stderr', 'exit 2']);
    } finally {
      exit.mockRestore();
    }
  });
});
