import type { OpenFamily } from './fonts.js';

/** The brand stacks a look reads, each under its name in the brand stylesheet (`--font-<name>`). */
const BRAND_STACKS = ['sans', 'serif', 'mono'] as const;

/** A font face as the page's font set holds it (`FontFace`). */
export interface FaceLike {
  family: string;
  weight: string;
  style: string;
  load: () => Promise<unknown>;
}

interface LoadLookFontsOptions<F extends FaceLike> {
  /** A computed style inside the brand scope, holding the brand stacks. */
  style: { getPropertyValue: (property: string) => string };
  families: readonly OpenFamily[];
  /** The URL a font file, relative to the fonts directory, is served at. */
  urlOf: (file: string) => string;
  /** The page's font set (`document.fonts`). */
  faces: Iterable<F> & { add: (face: F) => unknown };
  /** Makes a face from its family, CSS source, weight and style (`new FontFace`). */
  createFace: (family: string, source: string, weight: string, style: string) => F;
}

async function loadFace(face: FaceLike): Promise<void> {
  try {
    await face.load();
  } catch (error) {
    throw new Error(`font face ${face.family} ${face.weight} ${face.style} did not load`, {
      cause: error,
    });
  }
}

function brandStacks(style: LoadLookFontsOptions<FaceLike>['style']): Record<string, string> {
  const fonts: Record<string, string> = {};
  for (const name of BRAND_STACKS) {
    const stack = style.getPropertyValue(`--font-${name}`).trim();
    if (stack === '') {
      throw new Error(
        `the brand stylesheet sets no --font-${name}; is @hushbox/config/tailwind imported?`
      );
    }
    fonts[name] = stack;
  }
  return fonts;
}

/** Adds each face of the family the font set does not already hold. */
function registerFamily<F extends FaceLike>(
  family: OpenFamily,
  { urlOf, faces, createFace }: Pick<LoadLookFontsOptions<F>, 'urlOf' | 'faces' | 'createFace'>
): void {
  for (const face of family.faces) {
    const registered = [...faces].some(
      (held) =>
        held.family === face.family && held.weight === face.weight && held.style === face.style
    );
    if (!registered) {
      faces.add(createFace(face.family, `url(${urlOf(face.file)})`, face.weight, face.style));
    }
  }
}

/**
 * Registers every open-licence face with the page's font set, once, then loads
 * every face the page declares, the brand's and the open-licence ones, so text
 * a canvas draws is never set in a fallback. Returns each font as the CSS
 * family a canvas `font` takes.
 */
export async function loadLookFonts<F extends FaceLike>(
  options: LoadLookFontsOptions<F>
): Promise<Record<string, string>> {
  const fonts = brandStacks(options.style);
  for (const family of options.families) {
    if (family.name in fonts) {
      throw new Error(`open-licence font family "${family.name}" takes a name a brand stack holds`);
    }
    fonts[family.name] = `"${family.name}"`;
    registerFamily(family, options);
  }
  await Promise.all([...options.faces].map(async (face) => loadFace(face)));
  return fonts;
}
