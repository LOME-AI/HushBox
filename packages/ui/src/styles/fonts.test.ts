import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.join(stylesDir, 'fonts.css'), 'utf8');

interface FontFace {
  family: string;
  style: string;
  weight: string;
  display: string;
  url: string;
  unicodeRange: string;
}

function descriptor(block: string, name: string): string {
  const value = new RegExp(String.raw`${name}:\s*([^;]+);`).exec(block)?.[1];
  if (value === undefined) throw new Error(`@font-face block lacks ${name}: ${block}`);
  return value.replaceAll(/\s+/g, ' ').trim();
}

function fontFaces(source: string): FontFace[] {
  return [...source.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, block = '']) => ({
    family: descriptor(block, 'font-family').replaceAll("'", ''),
    style: descriptor(block, 'font-style'),
    weight: descriptor(block, 'font-weight'),
    display: descriptor(block, 'font-display'),
    url: /url\('([^']+)'\)/.exec(block)?.[1] ?? '',
    unicodeRange: descriptor(block, 'unicode-range'),
  }));
}

const faces = fontFaces(css);
const urls = [...css.matchAll(/url\((['"]?)(?<url>[^'")]+)\1\)/g)].map(
  (match) => match.groups?.['url'] ?? ''
);

describe('brand font faces', () => {
  it('declares at least one face', () => {
    expect(faces.length).toBeGreaterThan(0);
  });

  it.each(urls)('resolves url %s to a file beside the stylesheet', (url) => {
    expect(existsSync(path.join(stylesDir, url))).toBe(true);
  });

  it.each(faces.map((face) => [face.url, face.weight]))(
    'declares %s with a variable weight range',
    (_url, weight) => {
      expect(weight).toMatch(/^\d+ \d+$/);
    }
  );

  // The ranges are each file's own `wght` axis; JetBrains Mono's files stop at 400, not 100.
  it.each([
    ['Merriweather', '300 900'],
    ['Hanken Grotesk', '100 900'],
    ['JetBrains Mono', '400 800'],
  ])('declares every %s face across its file weight axis %s', (family, range) => {
    const weights = faces.filter((face) => face.family === family).map((face) => face.weight);
    expect(weights.length).toBeGreaterThan(0);
    expect(new Set(weights)).toEqual(new Set([range]));
  });

  it.each(faces.map((face) => [face.url, face.display]))(
    'swaps %s in when it loads',
    (_url, display) => {
      expect(display).toBe('swap');
    }
  );

  it.each([
    ['latin', './fonts/merriweather-latin.woff2', './fonts/merriweather-italic-latin.woff2'],
    [
      'latin-ext',
      './fonts/merriweather-latin-ext.woff2',
      './fonts/merriweather-italic-latin-ext.woff2',
    ],
  ])('serves a real Merriweather italic for the %s subset', (_subset, romanUrl, italicUrl) => {
    const roman = faces.find((face) => face.url === romanUrl);
    const italic = faces.find(
      (face) => face.family === 'Merriweather' && face.style === 'italic' && face.url === italicUrl
    );
    expect(italic).toMatchObject({ unicodeRange: roman?.unicodeRange ?? '<no roman face>' });
  });
});
