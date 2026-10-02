import { HEIGHT, WIDTH } from '../time/grid.js';

/** How many times smaller than the frame each thumbnail is drawn. */
const THUMB_DIVISOR = 5;
const COLUMNS = 8;
const GAP = 12;
/** Screen pixels per font pixel: the 5×7 digits are drawn this many times larger. */
const LABEL_SCALE = 3;
const LABEL_PADDING = 6;

const GLYPH_COLUMNS = 5;
const GLYPH_ROWS = 7;
const COLUMN_INDEXES = Array.from({ length: GLYPH_COLUMNS }, (_, column) => column);

/** The RGB of a label's digits. */
export const LABEL_INK: readonly [number, number, number] = [255, 255, 255];

/** The RGB the thumbnails and labels are laid on. */
export const SHEET_BACKGROUND: readonly [number, number, number] = [24, 24, 24];

/**
 * A 5×7 pixel face for the digits, drawn in code so a sheet's labels depend on
 * no font installed on the machine. `#` sets a pixel.
 */
const DIGITS: Readonly<Record<string, readonly string[]>> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
};

/** Where one frame's thumbnail and label sit on the sheet, in sheet pixels. */
export interface SheetTile {
  left: number;
  top: number;
  /** The top of the label, centred in the strip under the thumbnail and set at `left`. */
  labelTop: number;
}

export interface SheetLayout<T> {
  width: number;
  height: number;
  gap: number;
  thumbWidth: number;
  thumbHeight: number;
  /** The strip under each thumbnail that holds its label. */
  labelHeight: number;
  /** Each item given, in order, with where its tile sits. */
  tiles: (T & SheetTile)[];
}

/** An RGBA picture, four bytes a pixel, rows from the top. */
export interface LabelImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * The contact sheet for a set of frames: a thumbnail per frame, in the order
 * given, left to right and then down, each labelled with its frame number.
 */
export function sheetLayout<T extends { frame: number }>(frames: readonly T[]): SheetLayout<T> {
  if (frames.length === 0) {
    throw new RangeError('a contact sheet needs at least one frame');
  }
  const thumbWidth = WIDTH / THUMB_DIVISOR;
  const thumbHeight = HEIGHT / THUMB_DIVISOR;
  const glyphHeight = GLYPH_ROWS * LABEL_SCALE;
  const labelHeight = glyphHeight + 2 * LABEL_PADDING;
  const columns = Math.min(COLUMNS, frames.length);
  const rows = Math.ceil(frames.length / columns);
  const rowHeight = thumbHeight + labelHeight + GAP;
  return {
    width: GAP + columns * (thumbWidth + GAP),
    height: GAP + rows * rowHeight,
    gap: GAP,
    thumbWidth,
    thumbHeight,
    labelHeight,
    tiles: frames.map((item, index) => {
      const top = GAP + Math.floor(index / columns) * rowHeight;
      return {
        ...item,
        left: GAP + (index % columns) * (thumbWidth + GAP),
        top,
        labelTop: top + thumbHeight + (labelHeight - glyphHeight) / 2,
      };
    }),
  };
}

function glyphOf(character: string): readonly string[] {
  const glyph = DIGITS[character];
  if (glyph === undefined) {
    throw new RangeError(`a label holds digits only, got ${JSON.stringify(character)}`);
  }
  return glyph;
}

/** A pixel of the 5×7 face, in font pixels from the label's top-left corner. */
interface Dot {
  x: number;
  y: number;
}

/** The font pixels a label sets, its digits a blank font column apart. */
function labelDots(glyphs: readonly (readonly string[])[]): Dot[] {
  return glyphs.flatMap((glyph, index) =>
    glyph.flatMap((pattern, y) =>
      COLUMN_INDEXES.flatMap((column): Dot[] =>
        pattern.charAt(column) === '#' ? [{ x: index * (GLYPH_COLUMNS + 1) + column, y }] : []
      )
    )
  );
}

/** Inks the `LABEL_SCALE`-sided square a font pixel covers. */
function inkDot(pixels: Uint8Array, width: number, { x, y }: Dot): void {
  const ink = [...LABEL_INK, 255];
  for (let dy = 0; dy < LABEL_SCALE; dy++) {
    for (let dx = 0; dx < LABEL_SCALE; dx++) {
      pixels.set(ink, ((y * LABEL_SCALE + dy) * width + x * LABEL_SCALE + dx) * 4);
    }
  }
}

/** A label of digits drawn in `LABEL_INK` on transparency, a scaled pixel between digits. */
export function labelImage(text: string): LabelImage {
  const glyphs = Array.from(text, (character) => glyphOf(character));
  const width = (glyphs.length * (GLYPH_COLUMNS + 1) - 1) * LABEL_SCALE;
  const height = GLYPH_ROWS * LABEL_SCALE;
  const pixels = new Uint8Array(width * height * 4);
  for (const dot of labelDots(glyphs)) {
    inkDot(pixels, width, dot);
  }
  return { width, height, pixels };
}
