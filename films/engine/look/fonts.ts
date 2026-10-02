/** A font file the loader registers: one face of its family. */
const FONT_FILE = /\.(?:woff2?|otf|ttf)$/i;

/** A licence file as font families ship it: the SIL OFL, a licence or a copying notice. */
const LICENCE_FILE = /^(?:OFL|LICEN[CS]E|COPYING)(?:\.(?:txt|md))?$/i;

/** A family name a quoted CSS family carries as written. */
const FAMILY_NAME = /^[A-Za-z0-9][\w -]*$/;

/** A face's weight, or its variable range, and its style, at the end of the file's stem. */
const FACE_SUFFIX = /-(\d{1,4})(?:-(\d{1,4}))?(-italic)?$/;

const MIN_WEIGHT = 1;
const MAX_WEIGHT = 1000;

/** One face of an open-licence family, as `FontFace` registers it. */
export interface OpenFace {
  family: string;
  /** Its file, relative to the fonts directory, POSIX-separated. */
  file: string;
  /** A CSS weight, or a variable font's range as two weights. */
  weight: string;
  style: 'normal' | 'italic';
}

/** An open-licence family: its directory's name and its faces. */
export interface OpenFamily {
  name: string;
  faces: OpenFace[];
}

function isWeight(weight: number): boolean {
  return weight >= MIN_WEIGHT && weight <= MAX_WEIGHT;
}

/** The weight a face's name gives, or its variable range as two weights; null when it gives none. */
function weightOf(match: RegExpExecArray | null): string | null {
  if (match === null) {
    return null;
  }
  const low = Number(match[1]);
  if (match[2] === undefined) {
    return isWeight(low) ? String(low) : null;
  }
  const high = Number(match[2]);
  return isWeight(low) && isWeight(high) && low < high ? `${String(low)} ${String(high)}` : null;
}

function faceOf(family: string, file: string): OpenFace {
  const stem = file.slice(file.lastIndexOf('/') + 1).replace(FONT_FILE, '');
  const match = FACE_SUFFIX.exec(stem);
  const weight = weightOf(match);
  if (weight === null) {
    throw new Error(
      `font file ${file} names its weight at the end of its name, -<weight> or -<lightest>-<heaviest> for a variable font (each from ${String(MIN_WEIGHT)} to ${String(MAX_WEIGHT)}), then -italic for an italic`
    );
  }
  return { family, file, weight, style: match?.[3] === undefined ? 'normal' : 'italic' };
}

/** Each family directory of a listing and the names of the files directly in it. */
function filesByFamily(files: readonly string[]): Map<string, string[]> {
  const byFamily = new Map<string, string[]>();
  for (const file of files) {
    const parts = file.split('/');
    const [family, name] = parts;
    if (parts.length !== 2 || family === undefined || name === undefined) {
      if (FONT_FILE.test(file)) {
        throw new Error(
          `font file ${file} sits directly in films/fonts/<family>/, beside its licence`
        );
      }
      continue;
    }
    byFamily.set(family, [...(byFamily.get(family) ?? []), name]);
  }
  return byFamily;
}

function holdsFonts(names: readonly string[]): boolean {
  return names.some((name) => FONT_FILE.test(name));
}

/**
 * The open-licence families in a listing of the fonts directory (paths relative
 * to it, POSIX-separated): each directory holding a font file is a family named
 * after it. Other files are ignored, so a listing of the font files alone reads
 * the same families; the licence is checked on disk by {@link readFontFamilies}.
 */
export function fontFamilies(files: readonly string[]): OpenFamily[] {
  return [...filesByFamily(files).entries()]
    .filter(([, names]) => holdsFonts(names))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, names]) => {
      if (!FAMILY_NAME.test(name)) {
        throw new Error(
          `font family name ${JSON.stringify(name)} holds a character a CSS family name cannot carry quoted`
        );
      }
      return {
        name,
        faces: names
          .filter((file) => FONT_FILE.test(file))
          .toSorted((a, b) => a.localeCompare(b))
          .map((file) => faceOf(name, `${name}/${file}`)),
      };
    });
}

/** Refuses, by name, the first family in the listing that holds fonts and no licence file. */
function assertLicensed(files: readonly string[]): void {
  for (const [name, names] of filesByFamily(files)) {
    if (holdsFonts(names) && !names.some((file) => LICENCE_FILE.test(file))) {
      throw new Error(
        `open-licence font family "${name}" has no licence file (OFL, LICENSE, LICENCE or COPYING) beside its fonts in films/fonts/${name}/`
      );
    }
  }
}

/**
 * The open-licence families under a fonts directory on disk, each refused by
 * name unless its licence file sits beside its fonts; none when the directory
 * does not exist.
 */
export function readFontFamilies(root: string): OpenFamily[] {
  // Loaded at call time, never imported: the Remotion bundle imports this module
  // for `fontFamilies`, and webpack refuses a static `node:` import.
  const fs = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  if (!fs.existsSync(root)) {
    return [];
  }
  const files = fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
    );
  assertLicensed(files);
  return fontFamilies(files);
}
