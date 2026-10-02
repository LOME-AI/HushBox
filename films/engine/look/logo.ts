import { sampleAt } from '../audio/dsp/buffer.js';

/** RGBA pixels, row by row from the top left, as `getImageData` and a raw decode give them. */
export interface LogoPixels {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** A point in the logo image's pixel space: pixel (x, y) covers [x, x + 1) × [y, y + 1). */
export interface LogoPoint {
  x: number;
  y: number;
}

/** One connected shape of the mark, as the contour a look fills. */
export interface LogoPart {
  /** The closed contour, in the image's pixel space, with the shape on its left as y runs down. */
  outline: readonly LogoPoint[];
  /** The area the contour encloses, in square pixels. */
  area: number;
}

/** Half of full alpha: a pixel at or above it is inside the mark, and the contour runs where alpha crosses it. */
const HALF_ALPHA = 127.5;

/**
 * The grid the contour is traced on: one node per pixel centre, and a ring of
 * transparent nodes around the image, so every contour closes. Node (column, row) is
 * pixel (column − 1, row − 1), centred at (column − 0.5, row − 0.5).
 */
interface Grid {
  columns: number;
  rows: number;
  alpha: (column: number, row: number) => number;
}

/** Refuses pixel data that is not four bytes for each pixel of the image's size. */
function requirePixels({ width, height, data }: LogoPixels): void {
  const bytes = width * height * 4;
  if (data.length !== bytes) {
    throw new Error(
      `a ${String(width)}×${String(height)} logo image holds ${String(bytes)} bytes, got ${String(data.length)}`
    );
  }
}

/** The mark as a pixel set: 1 for each pixel at or above half alpha, 0 for the rest, row by row. */
export function logoMask(image: LogoPixels): Uint8Array {
  requirePixels(image);
  return Uint8Array.from({ length: image.width * image.height }, (_, pixel) =>
    sampleAt(image.data, pixel * 4 + 3) >= HALF_ALPHA ? 1 : 0
  );
}

function gridOf(image: LogoPixels): Grid {
  requirePixels(image);
  const { width, height, data } = image;
  return {
    columns: width + 2,
    rows: height + 2,
    alpha: (column, row) =>
      column < 1 || row < 1 || column > width || row > height
        ? 0
        : sampleAt(data, ((row - 1) * width + column - 1) * 4 + 3),
  };
}

/**
 * A grid edge's id: the edge from node (column, row) to (column + 1, row) is even, the edge
 * from node (column, row) to (column, row + 1) odd.
 */
function edgeId(grid: Grid, column: number, row: number, vertical: boolean): number {
  return (row * grid.columns + column) * 2 + (vertical ? 1 : 0);
}

/** Where the contour crosses an edge: linearly between its two nodes' alpha. */
function crossing(grid: Grid, edge: number): LogoPoint {
  const node = Math.floor(edge / 2);
  const column = node % grid.columns;
  const row = (node - column) / grid.columns;
  const vertical = edge % 2 === 1;
  const from = grid.alpha(column, row);
  const to = vertical ? grid.alpha(column, row + 1) : grid.alpha(column + 1, row);
  const t = (HALF_ALPHA - from) / (to - from);
  return vertical ? { x: column - 0.5, y: row - 0.5 + t } : { x: column - 0.5 + t, y: row - 0.5 };
}

/**
 * The contour's pieces in the cell whose top-left node is (column, row), each from the
 * edge it enters by to the edge it leaves by, recorded in `next`. Walking the
 * cell's corners clockwise, the contour enters where an outside corner is
 * followed by an inside one, and runs to an edge where an inside corner is
 * followed by an outside one, so the inside lies on its left. A cell with two
 * inside corners facing each other joins them when its centre, the mean of its
 * corners, is inside.
 */
function traceCell(grid: Grid, column: number, row: number, next: Int32Array): void {
  const topLeft = grid.alpha(column, row);
  const topRight = grid.alpha(column + 1, row);
  const bottomRight = grid.alpha(column + 1, row + 1);
  const bottomLeft = grid.alpha(column, row + 1);
  const walk = [
    [topLeft, topRight, edgeId(grid, column, row, false)],
    [topRight, bottomRight, edgeId(grid, column + 1, row, true)],
    [bottomRight, bottomLeft, edgeId(grid, column, row + 1, false)],
    [bottomLeft, topLeft, edgeId(grid, column, row, true)],
  ] as const;
  // Crossings alternate between entries and exits around the cell.
  const crossed: number[] = [];
  let firstIsEntry = false;
  for (const [from, to, edge] of walk) {
    const entry = to > HALF_ALPHA;
    if (from > HALF_ALPHA !== entry) {
      firstIsEntry ||= crossed.length === 0 && entry;
      crossed.push(edge);
    }
  }
  const count = crossed.length;
  const joined = (topLeft + topRight + bottomRight + bottomLeft) / 4 > HALF_ALPHA;
  const step = count === 4 && joined ? count - 1 : 1;
  for (const [index, edge] of crossed.entries()) {
    if ((index % 2 === 0) === firstIsEntry) {
      next[edge] = sampleAt(crossed, (index + step) % count);
    }
  }
}

/** Twice the signed area the segment from `a` to `b` sweeps about the origin. */
function sweep(a: LogoPoint, b: LogoPoint): number {
  return a.x * b.y - b.x * a.y;
}

/**
 * The mark in a logo image: the contour where its alpha crosses half, split
 * into its connected shapes (edge-connected pixels at or above half alpha),
 * one part per shape, in the order a raster scan first meets each. A shape
 * with a hole is refused, since a part is one filled outline.
 */
export function traceLogo(image: LogoPixels): LogoPart[] {
  const grid = gridOf(image);
  const next = new Int32Array(grid.columns * grid.rows * 2).fill(-1);
  for (let row = 0; row < grid.rows - 1; row += 1) {
    for (let column = 0; column < grid.columns - 1; column += 1) {
      traceCell(grid, column, row, next);
    }
  }
  const parts: LogoPart[] = [];
  for (const [start, following] of next.entries()) {
    if (following === -1) {
      continue;
    }
    const first = crossing(grid, start);
    const outline = [first];
    let previous = first;
    let twiceSigned = 0;
    next[start] = -1;
    for (let edge = following; edge !== start; ) {
      const point = crossing(grid, edge);
      outline.push(point);
      twiceSigned += sweep(previous, point);
      previous = point;
      const after = sampleAt(next, edge);
      next[edge] = -1;
      edge = after;
    }
    // With the shape on the left and y running down, an outer contour's signed area is negative.
    const area = -(twiceSigned + sweep(previous, first)) / 2;
    if (area < 0) {
      throw new Error(
        `the traced logo has a hole at (${String(first.x)}, ${String(first.y)}); each part is one filled outline`
      );
    }
    parts.push({ outline, area });
  }
  return parts;
}

/** An outline as one closed SVG subpath, which `Path2D` and an SVG `path` both take. */
export function logoPathData(outline: readonly LogoPoint[]): string {
  return `M${outline.map(({ x, y }) => [x, y].join(' ')).join('L')}Z`;
}
