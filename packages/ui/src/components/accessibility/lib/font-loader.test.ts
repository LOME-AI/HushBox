import { describe, it, expect, beforeEach, vi } from 'vitest';
import { activateFont, _resetFontLoaderForTesting } from './font-loader';

interface FontFaceCall {
  family: string;
  source: string;
  descriptors: { display?: string } | undefined;
}

interface MockFontFaceInstance {
  family: string;
  source: string;
  descriptors: { display?: string } | undefined;
  load: ReturnType<typeof vi.fn>;
}

const fontFaceCalls: FontFaceCall[] = [];
const fontFaceInstances: MockFontFaceInstance[] = [];

class MockFontFace {
  family: string;
  source: string;
  descriptors: { display?: string } | undefined;
  load: ReturnType<typeof vi.fn>;

  constructor(family: string, source: string, descriptors?: { display?: string }) {
    this.family = family;
    this.source = source;
    this.descriptors = descriptors;
    this.load = vi.fn().mockResolvedValue(this);
    fontFaceCalls.push({ family, source, descriptors });
    fontFaceInstances.push(this);
  }
}

const documentFontsAdd = vi.fn();

beforeEach(() => {
  fontFaceCalls.length = 0;
  fontFaceInstances.length = 0;
  documentFontsAdd.mockReset();
  _resetFontLoaderForTesting();
  document.documentElement.classList.remove('a11y-font-override');
  document.documentElement.style.removeProperty('--a11y-font-family');
  vi.stubGlobal('FontFace', MockFontFace);
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: documentFontsAdd },
  });
});

describe('activateFont — system / no-override branch', () => {
  it('removes the a11y-font-override class when called with system', async () => {
    document.documentElement.classList.add('a11y-font-override');
    await activateFont('system');
    expect(document.documentElement.classList.contains('a11y-font-override')).toBe(false);
  });

  it('clears the --a11y-font-family CSS variable when called with system', async () => {
    document.documentElement.style.setProperty('--a11y-font-family', '"atkinson"');
    await activateFont('system');
    expect(document.documentElement.style.getPropertyValue('--a11y-font-family')).toBe('');
  });

  it('does not construct a FontFace when called with system', async () => {
    await activateFont('system');
    expect(fontFaceCalls).toHaveLength(0);
  });

  it('does not call document.fonts.add when called with system', async () => {
    await activateFont('system');
    expect(documentFontsAdd).not.toHaveBeenCalled();
  });
});

describe('activateFont — load branch', () => {
  it('constructs a FontFace with the registry url and font-display:block', async () => {
    await activateFont('atkinson');
    expect(fontFaceCalls).toHaveLength(1);
    const call = fontFaceCalls[0]!;
    expect(call.family).toBe('atkinson');
    expect(call.source).toMatch(/^url\(.+\) format\('woff2'\)$/);
    expect(call.descriptors?.display).toBe('block');
  });

  it('awaits FontFace.load() before adding to document.fonts', async () => {
    await activateFont('atkinson');
    expect(fontFaceInstances).toHaveLength(1);
    const instance = fontFaceInstances[0]!;
    expect(instance.load).toHaveBeenCalledTimes(1);
    expect(documentFontsAdd).toHaveBeenCalledTimes(1);
    expect(documentFontsAdd).toHaveBeenCalledWith(instance);
  });

  it('sets the --a11y-font-family CSS variable to the loaded family', async () => {
    await activateFont('atkinson');
    expect(document.documentElement.style.getPropertyValue('--a11y-font-family')).toBe(
      '"atkinson"'
    );
  });

  it('adds the a11y-font-override class to the documentElement', async () => {
    await activateFont('atkinson');
    expect(document.documentElement.classList.contains('a11y-font-override')).toBe(true);
  });

  it('also activates open-dyslexic and lexend ids', async () => {
    await activateFont('open-dyslexic');
    expect(fontFaceCalls.at(-1)?.family).toBe('open-dyslexic');
    expect(document.documentElement.style.getPropertyValue('--a11y-font-family')).toBe(
      '"open-dyslexic"'
    );

    await activateFont('lexend');
    expect(fontFaceCalls.at(-1)?.family).toBe('lexend');
    expect(document.documentElement.style.getPropertyValue('--a11y-font-family')).toBe('"lexend"');
  });
});

describe('activateFont — idempotency', () => {
  it('does not re-construct a FontFace when called twice with the same id', async () => {
    await activateFont('atkinson');
    await activateFont('atkinson');
    expect(fontFaceCalls).toHaveLength(1);
    expect(fontFaceInstances[0]!.load).toHaveBeenCalledTimes(1);
    expect(documentFontsAdd).toHaveBeenCalledTimes(1);
  });

  it('still re-applies the CSS variable + class on repeat calls (so re-activation after system clears works)', async () => {
    await activateFont('atkinson');
    document.documentElement.classList.remove('a11y-font-override');
    document.documentElement.style.removeProperty('--a11y-font-family');
    await activateFont('atkinson');
    expect(document.documentElement.classList.contains('a11y-font-override')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--a11y-font-family')).toBe(
      '"atkinson"'
    );
  });

  it('switching from atkinson to lexend constructs lexend exactly once and overrides the CSS variable', async () => {
    await activateFont('atkinson');
    await activateFont('lexend');
    expect(fontFaceCalls.map((c) => c.family)).toEqual(['atkinson', 'lexend']);
    expect(document.documentElement.style.getPropertyValue('--a11y-font-family')).toBe('"lexend"');
  });
});

describe('activateFont — error branch', () => {
  it('throws on an unknown id', async () => {
    await expect(activateFont('not-a-real-font' as never)).rejects.toThrow(
      /Unknown accessibility font id: not-a-real-font/
    );
  });

  it('does not construct a FontFace on an unknown id', async () => {
    await expect(activateFont('totally-fake' as never)).rejects.toThrow();
    expect(fontFaceCalls).toHaveLength(0);
    expect(documentFontsAdd).not.toHaveBeenCalled();
  });
});

describe('_resetFontLoaderForTesting', () => {
  it('clears the loaded-fonts cache so subsequent calls re-construct FontFace', async () => {
    await activateFont('atkinson');
    _resetFontLoaderForTesting();
    await activateFont('atkinson');
    expect(fontFaceCalls).toHaveLength(2);
  });
});
