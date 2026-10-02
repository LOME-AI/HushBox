import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fontFamilies, readFontFamilies } from './fonts.js';

describe('fontFamilies', () => {
  it('reads a family from its font files, each face with its weight and style', () => {
    expect(fontFamilies(['anton/anton-400.woff2', 'anton/anton-700-italic.ttf'])).toEqual([
      {
        name: 'anton',
        faces: [
          { family: 'anton', file: 'anton/anton-400.woff2', weight: '400', style: 'normal' },
          { family: 'anton', file: 'anton/anton-700-italic.ttf', weight: '700', style: 'italic' },
        ],
      },
    ]);
  });

  it('reads a variable face as the range of weights its file name gives', () => {
    const [family] = fontFamilies(['inter/LICENSE', 'inter/inter-100-900.woff2']);

    expect(family?.faces[0]?.weight).toBe('100 900');
  });

  it('reads a family whose licence file the listing leaves out', () => {
    expect(fontFamilies(['anton/anton-400.otf']).map(({ name }) => name)).toEqual(['anton']);
  });

  it('orders families by name', () => {
    expect(
      fontFamilies(['b/OFL.txt', 'b/b-400.woff', 'a/OFL.txt', 'a/a-400.woff']).map(
        ({ name }) => name
      )
    ).toEqual(['a', 'b']);
  });

  it('skips a directory that holds no font file', () => {
    expect(fontFamilies(['notes/OFL.txt', 'notes/specimen.png'])).toEqual([]);
  });

  it('refuses a font file outside a family directory, naming it', () => {
    expect(() => fontFamilies(['anton-400.woff2'])).toThrow(
      /anton-400\.woff2.*films\/fonts\/<family>\//
    );
  });

  it('refuses a font file nested below a family directory, naming it', () => {
    expect(() => fontFamilies(['anton/OFL.txt', 'anton/static/anton-400.woff2'])).toThrow(
      /anton\/static\/anton-400\.woff2/
    );
  });

  it('refuses a family name a CSS family cannot carry, naming it', () => {
    expect(() => fontFamilies(['"quoted"/OFL.txt', '"quoted"/q-400.woff2'])).toThrow(
      /family name "\\"quoted\\""/
    );
  });

  it('refuses a face whose file name gives no weight, naming the file', () => {
    expect(() => fontFamilies(['anton/OFL.txt', 'anton/anton-bold.woff2'])).toThrow(
      /anton\/anton-bold\.woff2/
    );
  });

  it('accepts weights 1 and 1000, the ends of the CSS range', () => {
    const [family] = fontFamilies(['v/OFL.txt', 'v/v-1-1000.woff2']);

    expect(family?.faces[0]?.weight).toBe('1 1000');
  });

  it.each(['v/v-0.woff2', 'v/v-1001.woff2', 'v/v-700-400.woff2', 'v/v-400-400.woff2'])(
    'refuses the weight in %s, naming the file',
    (file) => {
      expect(() => fontFamilies(['v/OFL.txt', file])).toThrow(file);
    }
  );
});

describe('readFontFamilies', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'films-fonts-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(file: string): void {
    const target = path.join(root, ...file.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '');
  }

  it('reads every family in a fonts directory', () => {
    write('anton/OFL.txt');
    write('anton/anton-400.woff2');

    expect(readFontFamilies(root).map(({ name }) => name)).toEqual(['anton']);
  });

  it('fails naming a family in the directory that has no licence file', () => {
    write('anton/OFL.txt');
    write('anton/anton-400.woff2');
    write('unlicensed/unlicensed-400.woff2');

    expect(() => readFontFamilies(root)).toThrow(
      /open-licence font family "unlicensed" has no licence file/
    );
  });

  it.each(['LICENSE', 'LICENSE.txt', 'LICENCE.md', 'OFL.txt', 'COPYING', 'license.txt'])(
    'takes %s as the licence file',
    (licence) => {
      write(`anton/${licence}`);
      write('anton/anton-400.otf');

      expect(readFontFamilies(root).map(({ name }) => name)).toEqual(['anton']);
    }
  );

  it('takes no licence from a file in another family', () => {
    write('anton/OFL.txt');
    write('anton/anton-400.woff2');
    write('bebas/bebas-400.woff2');

    expect(() => readFontFamilies(root)).toThrow(/family "bebas" has no licence file/);
  });

  it('asks no licence of a directory that holds no font file', () => {
    write('notes/specimen.png');

    expect(readFontFamilies(root)).toEqual([]);
  });

  it('reads no family when the fonts directory does not exist', () => {
    expect(readFontFamilies(path.join(root, 'absent'))).toEqual([]);
  });
});
