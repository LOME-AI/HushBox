import { describe, expect, it } from 'vitest';

import { loadLookFonts } from './load-fonts.js';

import type { OpenFamily } from './fonts.js';
import type { FaceLike } from './load-fonts.js';

const STACKS: Readonly<Record<string, string>> = {
  '--font-sans': "'Hanken Grotesk', system-ui, sans-serif",
  '--font-serif': "'Merriweather', Georgia, serif",
  '--font-mono': "'JetBrains Mono', ui-monospace, monospace",
};

const style = { getPropertyValue: (property: string): string => STACKS[property] ?? '' };

const ANTON: OpenFamily = {
  name: 'anton',
  faces: [{ family: 'anton', file: 'anton/anton-400.woff2', weight: '400', style: 'normal' }],
};

interface FakeFace extends FaceLike {
  source: string;
  loads: number;
}

function fakeFace(family: string, source: string, weight: string, faceStyle: string): FakeFace {
  const face: FakeFace = {
    family,
    source,
    weight,
    style: faceStyle,
    loads: 0,
    load: async (): Promise<void> => {
      face.loads += 1;
      await Promise.resolve();
    },
  };
  return face;
}

function fakeSet(initial: FakeFace[]): Set<FakeFace> {
  return new Set(initial);
}

describe('loadLookFonts', () => {
  it('names the brand stacks under sans, serif and mono', async () => {
    const fonts = await loadLookFonts({
      style,
      families: [],
      urlOf: (file) => file,
      faces: fakeSet([]),
      createFace: fakeFace,
    });

    expect(fonts).toEqual({
      sans: STACKS['--font-sans'],
      serif: STACKS['--font-serif'],
      mono: STACKS['--font-mono'],
    });
  });

  it('names each open-licence family by its directory, quoted', async () => {
    const fonts = await loadLookFonts({
      style,
      families: [ANTON],
      urlOf: (file) => file,
      faces: fakeSet([]),
      createFace: fakeFace,
    });

    expect(fonts['anton']).toBe('"anton"');
  });

  it("registers each open-licence face from its file's URL with its weight and style", async () => {
    const faces = fakeSet([]);
    await loadLookFonts({
      style,
      families: [ANTON],
      urlOf: (file) => `/assets/${file}`,
      faces,
      createFace: fakeFace,
    });

    expect(
      [...faces].map(({ family, source, weight, style: s }) => ({ family, source, weight, s }))
    ).toEqual([
      { family: 'anton', source: 'url(/assets/anton/anton-400.woff2)', weight: '400', s: 'normal' },
    ]);
  });

  it('registers an open-licence face once however often the fonts load', async () => {
    const faces = fakeSet([]);
    const options = {
      style,
      families: [ANTON],
      urlOf: (file: string) => file,
      faces,
      createFace: fakeFace,
    };
    await loadLookFonts(options);
    await loadLookFonts(options);

    expect(faces.size).toBe(1);
  });

  it('loads every face the page declares, brand and open-licence', async () => {
    const brand = fakeFace('Merriweather', 'url(m.woff2)', '300 900', 'normal');
    const faces = fakeSet([brand]);
    await loadLookFonts({
      style,
      families: [ANTON],
      urlOf: (file) => file,
      faces,
      createFace: fakeFace,
    });

    expect([...faces].map(({ loads }) => loads)).toEqual([1, 1]);
  });

  it('fails naming a face that does not load', async () => {
    const broken: FakeFace = {
      ...fakeFace('Merriweather', 'url(m.woff2)', '300 900', 'italic'),
      load: async (): Promise<void> => {
        await Promise.reject(new Error('NetworkError'));
      },
    };

    await expect(
      loadLookFonts({
        style,
        families: [],
        urlOf: (file) => file,
        faces: fakeSet([broken]),
        createFace: fakeFace,
      })
    ).rejects.toThrow(/font face Merriweather 300 900 italic did not load/);
  });

  it('fails naming a brand stack the stylesheet does not set', async () => {
    await expect(
      loadLookFonts({
        style: { getPropertyValue: (property) => (property === '--font-mono' ? '' : 'x') },
        families: [],
        urlOf: (file) => file,
        faces: fakeSet([]),
        createFace: fakeFace,
      })
    ).rejects.toThrow(/--font-mono/);
  });

  it('refuses an open-licence family named like a brand stack, naming it', async () => {
    await expect(
      loadLookFonts({
        style,
        families: [{ ...ANTON, name: 'sans' }],
        urlOf: (file) => file,
        faces: fakeSet([]),
        createFace: fakeFace,
      })
    ).rejects.toThrow(/family "sans"/);
  });
});
