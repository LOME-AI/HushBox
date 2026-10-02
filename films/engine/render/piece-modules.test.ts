import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pieceModuleMap } from './piece-modules.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'films-piece-modules-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes an empty file at `file` (POSIX-separated, relative to the tree root). */
function write(file: string): void {
  const absolute = path.join(root, ...file.split('/'));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, '');
}

describe('pieceModuleMap', () => {
  it.each(['composition.tsx', 'film.ts', 'score.ts', 'look.ts', 'look.js'])(
    "maps the piece's own %s, keyed ./<dir>/<file>, to its path on disk",
    (file) => {
      write(`engine/fixtures/engine-look/${file}`);

      expect(pieceModuleMap(root, ['engine/fixtures/engine-look'])).toEqual({
        [`./engine/fixtures/engine-look/${file}`]: path.join(
          root,
          'engine',
          'fixtures',
          'engine-look',
          file
        ),
      });
    }
  );

  it('maps the modules of every piece listed', () => {
    write('2026-09-first/film.ts');
    write('2026-09-first/look.ts');
    write('2026-09-first/rounds/01/ember/look.ts');
    write('2026-09-first/rounds/01/ember/score.ts');

    expect(
      Object.keys(pieceModuleMap(root, ['2026-09-first', '2026-09-first/rounds/01/ember']))
    ).toEqual([
      './2026-09-first/film.ts',
      './2026-09-first/look.ts',
      './2026-09-first/rounds/01/ember/look.ts',
      './2026-09-first/rounds/01/ember/score.ts',
    ]);
  });

  it('leaves out a piece nested inside a listed piece', () => {
    write('engine/fixtures/engine-look/film.ts');
    write('engine/fixtures/engine-look/engine-look-gl/film.ts');

    expect(Object.keys(pieceModuleMap(root, ['engine/fixtures/engine-look']))).toEqual([
      './engine/fixtures/engine-look/film.ts',
    ]);
  });

  it('leaves out a piece that is not listed', () => {
    write('engine/fixtures/engine-look/film.ts');
    write('engine/fixtures/engine-render/film.ts');

    expect(Object.keys(pieceModuleMap(root, ['engine/fixtures/engine-look']))).toEqual([
      './engine/fixtures/engine-look/film.ts',
    ]);
  });

  it("leaves out a file of the piece's directory that is not a piece module", () => {
    write('engine/fixtures/engine-look/film.ts');
    write('engine/fixtures/engine-look/palette.ts');

    expect(Object.keys(pieceModuleMap(root, ['engine/fixtures/engine-look']))).toEqual([
      './engine/fixtures/engine-look/film.ts',
    ]);
  });

  it('leaves out a directory named like a piece module', () => {
    write('engine/fixtures/engine-look/film.ts');
    write('engine/fixtures/engine-look/look.ts/inner.ts');

    expect(Object.keys(pieceModuleMap(root, ['engine/fixtures/engine-look']))).toEqual([
      './engine/fixtures/engine-look/film.ts',
    ]);
  });

  it('maps nothing when no piece is listed', () => {
    write('engine/fixtures/engine-look/film.ts');

    expect(pieceModuleMap(root, [])).toEqual({});
  });

  it.each(['', '/abs/piece', '../outside', 'a/./b', 'a//b', String.raw`a\b`])(
    'refuses %j, which is not a POSIX-separated directory under the package',
    (dir) => {
      expect(() => pieceModuleMap(root, [dir])).toThrow(
        /is not a directory under the films package/
      );
    }
  );
});
