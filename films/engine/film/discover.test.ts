import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyLooks,
  discoverFilms,
  discoverTakes,
  loadPieceModule,
  registerFilms,
  registerTakes,
  takeCompositionId,
} from './discover.js';

/** A module that throws the moment it is imported. */
const THROWS_ON_IMPORT = "throw new Error('broken on import');\n";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'films-discover-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes a `film.ts` whose spec declares `id`, at `dir` (POSIX-separated, relative to the tree root). */
function writeFilm(dir: string, id: string): void {
  const directory = path.join(root, ...dir.split('/'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'film.ts'),
    `export const definition = { spec: { id: ${JSON.stringify(id)}, durationInFrames: 96 } };\n`
  );
}

describe('discoverFilms', () => {
  it('finds films, engine fixtures and nested compositions with their ids', () => {
    writeFilm('2026-09-first', '2026-09-first');
    writeFilm('2026-09-first/sheet', 'sheet');
    writeFilm('engine/fixtures/engine-empty', 'engine-empty');

    expect(discoverFilms(root)).toEqual([
      { id: '2026-09-first', dir: path.join(root, '2026-09-first') },
      { id: 'sheet', dir: path.join(root, '2026-09-first', 'sheet') },
      { id: 'engine-empty', dir: path.join(root, 'engine', 'fixtures', 'engine-empty') },
    ]);
  });

  it('skips film modules under node_modules and out', () => {
    writeFilm('2026-09-first', '2026-09-first');
    writeFilm('node_modules/some-package/stray', 'stray');
    writeFilm('2026-09-first/out/copy', 'copy');

    expect(discoverFilms(root).map((film) => film.id)).toEqual(['2026-09-first']);
  });

  it("lists a film under its directory's name, never reading the id its film.ts declares", () => {
    writeFilm('2026-09-first', 'something-else');

    expect(discoverFilms(root).map(({ id }) => id)).toEqual(['2026-09-first']);
  });

  it('lists a film without importing its film.ts', () => {
    writeFilm('2026-09-first', '2026-09-first');
    write('2026-09-broken/film.ts', THROWS_ON_IMPORT);

    expect(discoverFilms(root).map(({ id }) => id)).toEqual(['2026-09-broken', '2026-09-first']);
  });

  it('fails naming both directories when two films share a directory name, their id', () => {
    writeFilm('2026-09-first/sheet', 'sheet');
    writeFilm('2026-09-second/sheet', 'sheet');

    expect(() => discoverFilms(root)).toThrow(
      /2026-09-second\/sheet: film id "sheet" is already used by 2026-09-first\/sheet/
    );
  });
});

describe('loadPieceModule', () => {
  it("returns the exports of the piece's module", () => {
    writeFilm('2026-09-first', '2026-09-first');
    const [film] = discoverFilms(root);

    expect(film === undefined ? undefined : loadPieceModule(root, film, 'film.ts')).toHaveProperty(
      'definition',
      { spec: { id: '2026-09-first', durationInFrames: 96 } }
    );
  });

  it('fails naming the module, relative to the tree, when it throws on import', () => {
    write('2026-09-broken/film.ts', THROWS_ON_IMPORT);
    const [film] = discoverFilms(root);

    expect(() => (film === undefined ? undefined : loadPieceModule(root, film, 'film.ts'))).toThrow(
      /^2026-09-broken\/film\.ts: the module did not load: broken on import$/
    );
  });

  it('keeps what the module threw as the cause', () => {
    write('2026-09-broken/film.ts', THROWS_ON_IMPORT);
    const [film] = discoverFilms(root);

    let caught: unknown;
    try {
      if (film !== undefined) loadPieceModule(root, film, 'film.ts');
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof Error ? String(caught.cause) : caught).toBe('Error: broken on import');
  });

  it('names what the module threw when it is not an Error', () => {
    write('2026-09-broken/film.ts', "throw 'a bare string';\n");
    const [film] = discoverFilms(root);

    expect(() => (film === undefined ? undefined : loadPieceModule(root, film, 'film.ts'))).toThrow(
      /^2026-09-broken\/film\.ts: the module did not load: a bare string$/
    );
  });
});

describe('the fonts under the tree', () => {
  it('lets films be discovered when every font family holds its licence', () => {
    writeFilm('2026-09-first', '2026-09-first');
    write('fonts/anton/OFL.txt', 'SIL Open Font License');
    write('fonts/anton/anton-400.woff2', '');

    expect(discoverFilms(root).map(({ id }) => id)).toEqual(['2026-09-first']);
  });

  it('fails film discovery naming a font family with no licence file', () => {
    writeFilm('2026-09-first', '2026-09-first');
    write('fonts/unlicensed/unlicensed-400.woff2', '');

    expect(() => discoverFilms(root)).toThrow(
      /open-licence font family "unlicensed" has no licence file/
    );
  });

  it('fails take discovery naming a font family with no licence file', () => {
    write('fonts/unlicensed/unlicensed-400.woff2', '');

    expect(() => discoverTakes(root)).toThrow(/font family "unlicensed"/);
  });
});

describe('registerFilms', () => {
  it('returns the id, directory and duration of each film module', () => {
    const exports = { definition: { spec: { id: 'engine-empty', durationInFrames: 96 } } };

    expect(registerFilms([{ dir: 'engine/fixtures/engine-empty', exports }])).toEqual([
      { id: 'engine-empty', dir: 'engine/fixtures/engine-empty', durationInFrames: 96 },
    ]);
  });

  it('fails naming the directory when a module exports no film definition', () => {
    expect(() => registerFilms([{ dir: '2026-09-first', exports: { Component: null } }])).toThrow(
      /2026-09-first: .*definition/
    );
  });

  it('fails naming the directory when a spec has no whole-frame duration', () => {
    const exports = { definition: { spec: { id: '2026-09-first', durationInFrames: 1.5 } } };

    expect(() => registerFilms([{ dir: '2026-09-first', exports }])).toThrow(
      /2026-09-first: .*durationInFrames/
    );
  });

  it('fails naming the directory when a spec id differs from its directory name', () => {
    const exports = { definition: { spec: { id: 'something-else', durationInFrames: 96 } } };

    expect(() => registerFilms([{ dir: '2026-09-first', exports }])).toThrow(
      /2026-09-first: spec id "something-else" differs from its directory name/
    );
  });

  it('fails naming both directories when two specs share an id', () => {
    const exports = { definition: { spec: { id: 'sheet', durationInFrames: 96 } } };

    expect(() =>
      registerFilms([
        { dir: '2026-09-first/sheet', exports },
        { dir: '2026-09-second/sheet', exports },
      ])
    ).toThrow(/2026-09-second\/sheet: film id "sheet" is already used by 2026-09-first\/sheet/);
  });
});

describe('takeCompositionId', () => {
  it('spells a take path as a composition id, each separator a double hyphen', () => {
    expect(takeCompositionId('2026-09-first/rounds/01/ember')).toBe(
      '2026-09-first--rounds--01--ember'
    );
  });
});

describe('classifyLooks', () => {
  const none = { looks: [], films: [], scores: [], compositions: [] };

  it('pairs a look module with the film.ts beside it', () => {
    expect(
      classifyLooks({ ...none, looks: ['2026-09-first/look.ts'], films: ['2026-09-first'] })
    ).toEqual({ films: ['2026-09-first'], takes: [] });
  });

  it('takes a look module in a take directory beside its score.ts as a take', () => {
    expect(
      classifyLooks({
        ...none,
        looks: ['2026-09-first/rounds/01/ember/look.js'],
        films: ['2026-09-first'],
        scores: ['2026-09-first/score.ts', '2026-09-first/rounds/01/ember'],
      })
    ).toEqual({ films: [], takes: ['2026-09-first/rounds/01/ember'] });
  });

  it('refuses a look module with neither film.ts beside it nor a take directory, naming it', () => {
    expect(() => classifyLooks({ ...none, looks: ['2026-09-first/stray/look.ts'] })).toThrow(
      /2026-09-first\/stray: a look module sits beside film.ts/
    );
  });

  it('refuses a take directory whose look has no score.ts, naming it', () => {
    expect(() =>
      classifyLooks({ ...none, looks: ['2026-09-first/rounds/01/ember/look.ts'] })
    ).toThrow(/2026-09-first\/rounds\/01\/ember: .*score\.ts/);
  });

  it('refuses a round that is not two digits, naming the directory', () => {
    expect(() =>
      classifyLooks({
        ...none,
        looks: ['2026-09-first/rounds/1/ember/look.ts'],
        scores: ['2026-09-first/rounds/1/ember'],
      })
    ).toThrow(/2026-09-first\/rounds\/1\/ember: /);
  });

  it('refuses a take directory with a segment that is not kebab-case, naming it', () => {
    expect(() =>
      classifyLooks({
        ...none,
        looks: ['2026-09-first/rounds/01/Ember--hot/look.ts'],
        scores: ['2026-09-first/rounds/01/Ember--hot'],
      })
    ).toThrow(/rounds\/01\/Ember--hot: /);
  });

  it('refuses both look.ts and look.js in one directory, naming it', () => {
    expect(() =>
      classifyLooks({
        ...none,
        looks: ['2026-09-first/look.ts', '2026-09-first/look.js'],
        films: ['2026-09-first'],
      })
    ).toThrow(/2026-09-first: .*look\.ts and look\.js/);
  });

  it('refuses a look module beside a composition.tsx, naming the directory', () => {
    expect(() =>
      classifyLooks({
        ...none,
        looks: ['2026-09-first/look.ts'],
        films: ['2026-09-first'],
        compositions: ['2026-09-first'],
      })
    ).toThrow(/2026-09-first: .*composition\.tsx or a look module/);
  });
});

describe('registerTakes', () => {
  const exports = { definition: { spec: { id: 'ember', durationInFrames: 96 } } };

  it('registers a take by its path under the package, with its duration', () => {
    expect(registerTakes([{ dir: '2026-09-first/rounds/01/ember', exports }])).toEqual([
      {
        id: '2026-09-first/rounds/01/ember',
        dir: '2026-09-first/rounds/01/ember',
        durationInFrames: 96,
      },
    ]);
  });

  it('fails naming the take when its score.ts exports no definition', () => {
    expect(() => registerTakes([{ dir: '2026-09-first/rounds/01/ember', exports: {} }])).toThrow(
      /2026-09-first\/rounds\/01\/ember: .*definition/
    );
  });

  it('refuses a directory that is not a take directory, naming it', () => {
    expect(() => registerTakes([{ dir: '2026-09-first/ember', exports }])).toThrow(
      /2026-09-first\/ember: .*rounds/
    );
  });
});

function write(file: string, content: string): void {
  const target = path.join(root, ...file.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** A take's `score.ts`, whose spec declares `id`. */
function takeScore(id: string): string {
  return `export const definition = { spec: { id: ${JSON.stringify(id)}, durationInFrames: 48 } };\n`;
}

describe('discoverTakes', () => {
  it('registers a take by its path under the tree, beside a film', () => {
    writeFilm('2026-09-first', '2026-09-first');
    write('2026-09-first/look.ts', 'export const context = "2d";\n');
    write('2026-09-first/rounds/01/ember/look.js', 'export const context = "2d";\n');
    write('2026-09-first/rounds/01/ember/score.ts', takeScore('ember'));

    expect(discoverTakes(root)).toEqual([
      {
        id: '2026-09-first/rounds/01/ember',
        dir: path.join(root, '2026-09-first', 'rounds', '01', 'ember'),
      },
    ]);
    expect(discoverFilms(root).map(({ id }) => id)).toEqual(['2026-09-first']);
  });

  it('orders takes by path and skips those under node_modules and out', () => {
    write('2026-09-first/rounds/02/b/look.ts', '');
    write('2026-09-first/rounds/02/b/score.ts', takeScore('b'));
    write('2026-09-first/rounds/01/a/look.ts', '');
    write('2026-09-first/rounds/01/a/score.ts', takeScore('a'));
    write('2026-09-first/rounds/01/a/out/rounds/01/c/look.ts', '');

    expect(discoverTakes(root).map(({ id }) => id)).toEqual([
      '2026-09-first/rounds/01/a',
      '2026-09-first/rounds/02/b',
    ]);
  });

  it('lists a take without importing its score.ts', () => {
    write('2026-09-first/rounds/01/a/look.ts', '');
    write('2026-09-first/rounds/01/a/score.ts', takeScore('a'));
    write('2026-09-first/rounds/01/broken/look.ts', '');
    write('2026-09-first/rounds/01/broken/score.ts', THROWS_ON_IMPORT);

    expect(discoverTakes(root).map(({ id }) => id)).toEqual([
      '2026-09-first/rounds/01/a',
      '2026-09-first/rounds/01/broken',
    ]);
  });

  it('fails naming a look module that belongs to no film and no take', () => {
    write('2026-09-first/stray/look.ts', '');

    expect(() => discoverTakes(root)).toThrow(/2026-09-first\/stray: a look module/);
  });
});
