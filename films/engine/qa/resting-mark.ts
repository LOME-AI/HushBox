import { logoMask } from '../look/logo.js';
import { at } from './at.js';
import { contrastRatio } from './contrast.js';
import { gateResult } from './gate.js';
import { highestBy, lowestBy } from './pick.js';
import {
  COLOR_CHANNELS,
  linearChannel,
  percentile,
  relativeLuminance,
  requireRaster,
} from './raster.js';

import type { LogoBox } from '../look/contract.js';
import type { LogoPixels } from '../look/logo.js';
import type { GateFailure, GateResult } from './gate.js';
import type { Raster } from './raster.js';

/** The least intersection over union a resting mark's drawn pixels may have with the logo file's opaque pixels. */
export const RESTING_MARK_FLOOR = 0.99;

/** The most a resting mark's box proportions (width over height) may differ from the logo file's, as a fraction of the file's. */
export const RESTING_MARK_PROPORTION = 0.01;

/** The largest CIEDE2000 difference a resting mark's colour may have from the logo file's own colour. */
export const RESTING_MARK_COLOUR_DIFFERENCE = 3;

/** The least WCAG contrast ratio a resting mark's colour may have against its surroundings. */
export const RESTING_MARK_CONTRAST = 3;

/**
 * The logo file as the gate compares with it: its size, its opaque pixels (1
 * inside the mark, row by row), and its mark colour as 8-bit sRGB channels.
 */
export interface MarkImage {
  width: number;
  height: number;
  mask: Uint8Array;
  colour: readonly number[];
}

/** A compared frame, a resting mark the look reported on it, and the logo file it must match. */
export interface RestingMarkInput {
  frame: number;
  mark: LogoBox;
  drawn: Raster;
  logo: MarkImage;
}

/**
 * How one resting mark compared with the logo file on one compared frame:
 * its intersection over union with the file's opaque pixels, how far its box's
 * proportions are from the file's, its colour and its surroundings' as 8-bit
 * sRGB, its colour's CIEDE2000 difference from the file's, and its WCAG
 * contrast against its surroundings. When its box reaches outside the frame,
 * the box described and no match.
 */
export type RestingMark = { frame: number; id: string } & (
  | {
      iou: number;
      outside: null;
      grid: ComparisonGrid;
      proportion: number;
      colour: readonly number[];
      surroundings: readonly number[];
      deltaE: number;
      contrast: number;
    }
  | { iou: null; outside: string }
);

/**
 * Which resolution one axis of the comparison takes: the logo file's, with the
 * drawing box-filtered down to it, or the box's in drawn pixels, with the file
 * box-filtered down to it.
 */
export type GridSide = 'file' | 'box';

/** The grid a resting mark was compared on: its size in cells, and the resolution each axis took. */
export interface ComparisonGrid {
  width: number;
  height: number;
  across: GridSide;
  down: GridSide;
}

/** A CIELAB colour: lightness, then the a and b axes. */
export type Lab = readonly [number, number, number];

/** CIE D65's white point in XYZ, Y at 1. */
const D65 = [0.950_47, 1, 1.088_83] as const;

/** sRGB's linear light to CIE XYZ under D65, row by row. */
const SRGB_TO_XYZ = [
  [0.412_456_4, 0.357_576_1, 0.180_437_5],
  [0.212_672_9, 0.715_152_2, 0.072_175],
  [0.019_333_9, 0.119_192, 0.950_304_1],
] as const;

/** CIELAB's companding: a cube root above (6 / 29)³, a line below it. */
function labCompand(ratio: number): number {
  const knee = 6 / 29;
  return ratio > knee ** 3 ? Math.cbrt(ratio) : ratio / (3 * knee ** 2) + 4 / 29;
}

/** One CIE XYZ component of a linear-light sRGB colour, over D65's white on that axis. */
function whiteRelative(
  linear: readonly number[],
  weights: readonly number[],
  white: number
): number {
  return weights.reduce((sum, weight, channel) => sum + weight * at(linear, channel), 0) / white;
}

/** An 8-bit sRGB colour, channels possibly fractional, as CIELAB under D65. */
export function labOf(colour: readonly number[]): Lab {
  const linear = [0, 1, 2].map((channel) => linearChannel(at(colour, channel)));
  const [xRow, yRow, zRow] = SRGB_TO_XYZ;
  const x = labCompand(whiteRelative(linear, xRow, D65[0]));
  const y = labCompand(whiteRelative(linear, yRow, D65[1]));
  const z = labCompand(whiteRelative(linear, zRow, D65[2]));
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const DEGREES = 180 / Math.PI;

function radians(degrees: number): number {
  return degrees / DEGREES;
}

/** A hue angle in degrees, in [0, 360). */
function hueOf(b: number, a: number): number {
  const hue = Math.atan2(b, a) * DEGREES;
  return hue < 0 ? hue + 360 : hue;
}

/** The share of chroma CIEDE2000 weighs toward its rotation and a-axis terms: C⁷ / (C⁷ + 25⁷). */
function chromaWeight(chroma: number): number {
  return Math.sqrt(chroma ** 7 / (chroma ** 7 + 25 ** 7));
}

/** The hue difference h₂ − h₁, wrapped into [−180, 180]; zero when either colour is neutral. */
function hueDifference(one: number, two: number, neutral: boolean): number {
  if (neutral) {
    return 0;
  }
  const difference = two - one;
  if (difference > 180) {
    return difference - 360;
  }
  return difference < -180 ? difference + 360 : difference;
}

/** The mean hue, the long way round when the two hues lie more than 180° apart; their sum when either colour is neutral. */
function meanHue(one: number, two: number, neutral: boolean): number {
  if (neutral) {
    return one + two;
  }
  if (Math.abs(one - two) <= 180) {
    return (one + two) / 2;
  }
  return one + two < 360 ? (one + two + 360) / 2 : (one + two - 360) / 2;
}

/** CIEDE2000's hue weighting T at the mean hue. */
function hueWeighting(hue: number): number {
  return (
    1 -
    0.17 * Math.cos(radians(hue - 30)) +
    0.24 * Math.cos(radians(2 * hue)) +
    0.32 * Math.cos(radians(3 * hue + 6)) -
    0.2 * Math.cos(radians(4 * hue - 63))
  );
}

/**
 * The CIEDE2000 colour difference between two CIELAB colours, with the
 * parametric weights at 1, as Sharma, Wu and Dalal's implementation notes give it.
 */
export function deltaE2000([l1, a1, b1]: Lab, [l2, a2, b2]: Lab): number {
  const g = 0.5 * (1 - chromaWeight((Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2));
  const [a1Prime, a2Prime] = [(1 + g) * a1, (1 + g) * a2];
  const [c1, c2] = [Math.hypot(a1Prime, b1), Math.hypot(a2Prime, b2)];
  const [h1, h2] = [hueOf(b1, a1Prime), hueOf(b2, a2Prime)];
  const neutral = c1 * c2 === 0;
  const hueStep = 2 * Math.sqrt(c1 * c2) * Math.sin(radians(hueDifference(h1, h2, neutral) / 2));
  const lightness = (l1 + l2) / 2;
  const chroma = (c1 + c2) / 2;
  const hue = meanHue(h1, h2, neutral);
  const fromMidGrey = (lightness - 50) ** 2;
  const lightnessScale = 1 + (0.015 * fromMidGrey) / Math.sqrt(20 + fromMidGrey);
  const chromaScale = 1 + 0.045 * chroma;
  const hueScale = 1 + 0.015 * chroma * hueWeighting(hue);
  const rotation =
    -Math.sin(radians(2 * 30 * Math.exp(-(((hue - 275) / 25) ** 2)))) * 2 * chromaWeight(chroma);
  const [dl, dc, dh] = [(l2 - l1) / lightnessScale, (c2 - c1) / chromaScale, hueStep / hueScale];
  return Math.sqrt(dl * dl + dc * dc + dh * dh + rotation * dc * dh);
}

/**
 * The logo file as the gate compares with it, from its RGBA pixels: the mark
 * as a pixel set at half alpha, and its colour as the per-channel median of
 * the opaque pixels.
 */
export function markImageOf(pixels: LogoPixels): MarkImage {
  const mask = logoMask(pixels);
  const opaque = [...mask.keys()].filter((pixel) => mask[pixel] === 1);
  const colour = [0, 1, 2].map((channel) =>
    percentile(
      opaque.map((pixel) => at(pixels.data, pixel * 4 + channel)),
      50
    )
  );
  return { width: pixels.width, height: pixels.height, mask, colour };
}

function sameBox(one: LogoBox['box'], two: LogoBox['box']): boolean {
  return one.x === two.x && one.y === two.y && one.width === two.width && one.height === two.height;
}

/** Whether the rest at `index` of one mark's rests, sorted by frame, is the adjacent frame in the same box. */
function continues(
  rests: readonly (readonly [number, LogoBox['box']])[],
  index: number,
  [frame, box]: readonly [number, LogoBox['box']]
): boolean {
  const neighbour = rests[index];
  return (
    neighbour !== undefined && Math.abs(neighbour[0] - frame) === 1 && sameBox(neighbour[1], box)
  );
}

/**
 * The first and the last frame of each resting run, ascending: a run is the
 * consecutive frames on which one mark id rests in one unchanged box, so a
 * box that moves or resizes starts a new run. These are the frames the gate
 * compares whether or not a probe lands on them.
 */
export function restingRunEnds(
  rendered: Iterable<readonly [number, readonly LogoBox[]]>
): number[] {
  const byId = new Map<string, [number, LogoBox['box']][]>();
  for (const [frame, marks] of rendered) {
    for (const { id, box } of marks) {
      byId.set(id, [...(byId.get(id) ?? []), [frame, box]]);
    }
  }
  const ends = new Set<number>();
  for (const rests of byId.values()) {
    const sorted = rests.toSorted(([a], [b]) => a - b);
    for (const [index, rest] of sorted.entries()) {
      if (!continues(sorted, index - 1, rest) || !continues(sorted, index + 1, rest)) {
        ends.add(rest[0]);
      }
    }
  }
  return [...ends].toSorted((a, b) => a - b);
}

function px(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function describeBox({ x, y, width, height }: LogoBox['box']): string {
  return `x ${px(x)}–${px(x + width)}, y ${px(y)}–${px(y + height)}`;
}

function requireMarkImage({ width, height, mask, colour }: MarkImage): void {
  const values = width * height;
  if (mask.length !== values) {
    throw new RangeError(
      `a ${String(width)}×${String(height)} logo mask holds ${String(values)} values, got ${String(mask.length)}`
    );
  }
  const inside = mask.reduce((sum, value) => sum + value, 0);
  if (inside === 0 || inside === values) {
    throw new RangeError('a logo mask needs pixels inside the mark and outside it');
  }
  if (colour.length !== COLOR_CHANNELS) {
    throw new RangeError(
      `a logo colour holds ${String(COLOR_CHANNELS)} channels, got ${String(colour.length)}`
    );
  }
}

/** The drawn pixels, `[from, to)` along one axis, that one comparison cell reads. */
type Span = readonly [number, number];

/** One of the file's pixels along one axis, and the weight it carries in a comparison cell. */
type Share = readonly [index: number, weight: number];

/** One comparison cell along one axis: the drawn pixels it averages and the file pixels it weighs. */
interface Cell {
  drawn: Span;
  file: readonly Share[];
}

/**
 * Along an axis where the mark is drawn at least as large as the file, one
 * cell per file pixel, reading the drawn pixels whose centres fall inside its
 * footprint `[start + index × step, start + (index + 1) × step)`; a step of at
 * least one pixel always holds a centre.
 */
function fileCells(start: number, step: number, count: number): Cell[] {
  return Array.from({ length: count }, (_, index) => ({
    drawn: [Math.ceil(start + index * step - 0.5), Math.ceil(start + (index + 1) * step - 0.5)],
    file: [[index, 1]],
  }));
}

/**
 * Along an axis where the mark is drawn smaller than the file, one cell per
 * drawn pixel whose centre lies inside the box, weighing each file pixel by
 * the length of it the drawn pixel's footprint covers, clipped to the file.
 */
function drawnCells(start: number, step: number, count: number): Cell[] {
  const first = Math.ceil(start - 0.5);
  const last = Math.ceil(start + count * step - 0.5);
  return Array.from({ length: Math.max(0, last - first) }, (_, offset) => {
    const pixel = first + offset;
    const from = Math.max(0, (pixel - start) / step);
    const to = Math.min(count, (pixel + 1 - start) / step);
    const file: Share[] = [];
    for (let index = Math.floor(from); index < to; index++) {
      file.push([index, Math.min(to, index + 1) - Math.max(from, index)]);
    }
    return { drawn: [pixel, pixel + 1], file };
  });
}

/**
 * The comparison cells along one axis, at the coarser of the drawing's and
 * the file's resolutions, so neither side is ever upsampled. Null when any
 * drawn pixel a cell reads lies outside the frame.
 */
function axisCells(
  start: number,
  span: number,
  count: number,
  limit: number
): { cells: Cell[]; side: GridSide } | null {
  const step = span / count;
  const side: GridSide = step >= 1 ? 'file' : 'box';
  const cells = side === 'file' ? fileCells(start, step, count) : drawnCells(start, step, count);
  return cells.every(({ drawn: [from, to] }) => from >= 0 && to <= limit) ? { cells, side } : null;
}

/** Writes the mean colour of the drawn pixels in the block `[columns, rows]` into `target` at `offset`. */
function meanInto(
  target: Float64Array,
  offset: number,
  drawn: Raster,
  [[left, right], [top, bottom]]: readonly [Span, Span]
): void {
  const count = (right - left) * (bottom - top);
  for (let channel = 0; channel < COLOR_CHANNELS; channel++) {
    let sum = 0;
    for (let row = top; row < bottom; row++) {
      for (let column = left; column < right; column++) {
        sum += at(drawn.data, (row * drawn.width + column) * drawn.channels + channel);
      }
    }
    target[offset + channel] = sum / count;
  }
}

/** The weighted share of the file's opaque pixels under one cell: the file box-filtered to that cell. */
function coverage(logo: MarkImage, columns: readonly Share[], rows: readonly Share[]): number {
  let opaque = 0;
  let total = 0;
  for (const [row, tall] of rows) {
    for (const [column, wide] of columns) {
      opaque += tall * wide * at(logo.mask, row * logo.width + column);
      total += tall * wide;
    }
  }
  return opaque / total;
}

/** The per-channel median colour of the cells whose mask value is `side`. */
function medianColour(colours: Float64Array, mask: Uint8Array, side: number): number[] {
  const count = mask.reduce((sum, value) => sum + (value === side ? 1 : 0), 0);
  return Array.from({ length: COLOR_CHANNELS }, (_, channel) => {
    const values = new Float64Array(count);
    let next = 0;
    for (const [cell, value] of mask.entries()) {
      if (value === side) {
        values[next] = at(colours, cell * COLOR_CHANNELS + channel);
        next += 1;
      }
    }
    return percentile(values, 50);
  });
}

function squaredDistance(colours: Float64Array, cell: number, colour: readonly number[]): number {
  let sum = 0;
  for (let channel = 0; channel < COLOR_CHANNELS; channel++) {
    const difference = at(colours, cell * COLOR_CHANNELS + channel) - at(colour, channel);
    sum += difference * difference;
  }
  return sum;
}

/** {@link relativeLuminance} of a colour given as its three channels. */
function luminanceOf(colour: readonly number[]): number {
  return relativeLuminance(at(colour, 0), at(colour, 1), at(colour, 2));
}

/** The drawn box and the file resampled onto one grid of comparison cells: each cell's mean drawn colour and its thresholded file coverage. */
function resampled(
  drawn: Raster,
  logo: MarkImage,
  columns: readonly Cell[],
  rows: readonly Cell[]
): { colours: Float64Array; mask: Uint8Array } {
  const colours = new Float64Array(columns.length * rows.length * COLOR_CHANNELS);
  const mask = new Uint8Array(columns.length * rows.length);
  for (const [y, row] of rows.entries()) {
    for (const [x, column] of columns.entries()) {
      const cell = y * columns.length + x;
      meanInto(colours, cell * COLOR_CHANNELS, drawn, [column.drawn, row.drawn]);
      mask[cell] = coverage(logo, column.file, row.file) >= 0.5 ? 1 : 0;
    }
  }
  return { colours, mask };
}

const UNREAD = [Number.NaN, Number.NaN, Number.NaN] as const;

/**
 * How well a resting mark matches the logo file. The drawn box and the file
 * are brought to one grid at the coarser of their two resolutions, so neither
 * is upsampled: where the mark is drawn larger than the file, each file pixel
 * takes the mean colour of the drawn pixels its footprint covers; where it is
 * drawn smaller, each drawn pixel is compared with the file box-filtered to
 * its footprint and thresholded at half. The mark is then told from its
 * surroundings by colour alone: its colour is the median of the cells the file
 * covers, its surroundings' the median of the rest, and a cell is drawn mark
 * when it is strictly nearer the first. The medians hold against a partly
 * wrong drawing, a background that varies and a glow that stays below halfway,
 * and a box in which the mark and its surroundings are one colour matches
 * nothing. The two colours also give the mark's CIEDE2000 difference from the
 * file's colour and its contrast against its surroundings; a box too small to
 * hold both reads neither and matches nothing.
 */
export function measureRestingMark({ frame, mark, drawn, logo }: RestingMarkInput): RestingMark {
  requireRaster(drawn);
  requireMarkImage(logo);
  const { box } = mark;
  const columns = axisCells(box.x, box.width, logo.width, drawn.width);
  const rows = axisCells(box.y, box.height, logo.height, drawn.height);
  if (columns === null || rows === null) {
    return { frame, id: mark.id, iou: null, outside: describeBox(box) };
  }
  const proportion = Math.abs(box.width / box.height / (logo.width / logo.height) - 1);
  const grid: ComparisonGrid = {
    width: columns.cells.length,
    height: rows.cells.length,
    across: columns.side,
    down: rows.side,
  };
  const { colours, mask } = resampled(drawn, logo, columns.cells, rows.cells);
  const inside = mask.reduce((sum, value) => sum + value, 0);
  if (inside === 0 || inside === mask.length) {
    return {
      frame,
      id: mark.id,
      iou: 0,
      outside: null,
      grid,
      proportion,
      colour: UNREAD,
      surroundings: UNREAD,
      deltaE: Number.NaN,
      contrast: Number.NaN,
    };
  }
  const colour = medianColour(colours, mask, 1);
  const surroundings = medianColour(colours, mask, 0);
  let both = 0;
  let either = 0;
  for (const [cell, opaque] of mask.entries()) {
    const isDrawn =
      squaredDistance(colours, cell, colour) < squaredDistance(colours, cell, surroundings);
    both += isDrawn && opaque === 1 ? 1 : 0;
    either += isDrawn || opaque === 1 ? 1 : 0;
  }
  return {
    frame,
    id: mark.id,
    iou: both / either,
    outside: null,
    grid,
    proportion,
    colour,
    surroundings,
    deltaE: deltaE2000(labOf(colour), labOf(logo.colour)),
    contrast: contrastRatio(luminanceOf(colour), luminanceOf(surroundings)),
  };
}

type Matched = Extract<RestingMark, { outside: null }>;

function where({ frame, id }: { frame: number; id: string }): string {
  return `frame ${String(frame)}, mark ${JSON.stringify(id)}`;
}

function rgb(colour: readonly number[]): string {
  return `rgb(${colour.map((channel) => String(Math.round(channel))).join(', ')})`;
}

/** How the shape was compared, as the comparison grid's size and the resolution each axis took. */
function comparedOn({ width, height, across, down }: ComparisonGrid): string {
  const size = `${String(width)}×${String(height)}`;
  if (across === 'file' && down === 'file') {
    return `the pixels drawn in its box, box-filtered to the logo file’s ${size}, match the file’s opaque pixels`;
  }
  if (across === 'box' && down === 'box') {
    return `the pixels drawn in its box, read at the box’s ${size}, match the logo file box-filtered down to that size`;
  }
  return `the pixels drawn in its box and the logo file, each box-filtered to a ${size} grid (the ${across === 'file' ? 'file' : 'box'}’s resolution across, the ${down === 'file' ? 'file' : 'box'}’s down), match`;
}

/** One way a matched resting mark can fall short of the logo: its rule, when it fails (a measure that is not a number fails), and its cause. */
interface LookCheck {
  rule: string;
  fails: (measure: Matched) => boolean;
  detail: (measure: Matched) => string;
}

const LOOK_CHECKS: readonly LookCheck[] = [
  {
    rule: 'resting-mark',
    fails: ({ iou }) => Number.isNaN(iou) || iou < RESTING_MARK_FLOOR,
    detail: ({ iou, grid }) =>
      `${comparedOn(grid)} at IoU ${iou.toFixed(5)}, below ${String(RESTING_MARK_FLOOR)}`,
  },
  {
    rule: 'resting-mark-proportion',
    fails: ({ proportion }) => Number.isNaN(proportion) || proportion > RESTING_MARK_PROPORTION,
    detail: ({ proportion }) =>
      `its box’s proportions differ from the logo file’s by ${(proportion * 100).toFixed(2)} %, above ${String(RESTING_MARK_PROPORTION * 100)} %`,
  },
  {
    rule: 'resting-mark-colour',
    fails: ({ deltaE }) => Number.isNaN(deltaE) || deltaE > RESTING_MARK_COLOUR_DIFFERENCE,
    detail: ({ colour, deltaE }) =>
      `its colour ${rgb(colour)} differs from the logo file’s by ΔE00 ${deltaE.toFixed(2)}, above ${String(RESTING_MARK_COLOUR_DIFFERENCE)}`,
  },
  {
    rule: 'resting-mark-contrast',
    fails: ({ contrast }) => Number.isNaN(contrast) || contrast < RESTING_MARK_CONTRAST,
    detail: ({ colour, surroundings, contrast }) =>
      `its colour ${rgb(colour)} against its surroundings ${rgb(surroundings)} contrasts at ${contrast.toFixed(2)}:1, below ${String(RESTING_MARK_CONTRAST)}:1`,
  },
];

function markFailures(filmId: string, measure: RestingMark): GateFailure[] {
  if (measure.outside !== null) {
    return [
      {
        filmId,
        rule: 'resting-mark',
        at: where(measure),
        detail: `its box ${measure.outside} reaches outside the frame`,
      },
    ];
  }
  return LOOK_CHECKS.filter(({ fails }) => fails(measure)).map(({ rule, detail }) => ({
    filmId,
    rule,
    at: where(measure),
    detail: detail(measure),
  }));
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** The worst proportion, colour difference and contrast among the matched marks, one line each. */
function lookLines(matched: readonly Matched[]): string[] {
  const proportion = highestBy(matched, (measure) => measure.proportion);
  const colour = highestBy(matched, (measure) => measure.deltaE);
  const contrast = lowestBy(matched, (measure) => measure.contrast);
  if (proportion === null || colour === null || contrast === null) {
    return [];
  }
  return [
    `largest proportion difference ${(proportion.proportion * 100).toFixed(2)} % (${where(proportion)})`,
    `largest colour difference ΔE00 ${colour.deltaE.toFixed(2)} (${where(colour)})`,
    `lowest contrast ${contrast.contrast.toFixed(2)}:1 (${where(contrast)})`,
  ];
}

/**
 * The logo at rest: on every compared frame (each probe frame that reports a
 * resting mark, and the first and last frame of each resting run), each
 * resting mark the look reports matches the logo file's opaque pixels at an
 * IoU of at least {@link RESTING_MARK_FLOOR}, sits in a box within
 * {@link RESTING_MARK_PROPORTION} of the file's proportions, is drawn within
 * {@link RESTING_MARK_COLOUR_DIFFERENCE} (CIEDE2000) of the file's colour, and
 * stands at least {@link RESTING_MARK_CONTRAST}:1 against its surroundings,
 * each measured by {@link measureRestingMark}.
 */
export function restingMarkGate(filmId: string, marks: readonly RestingMark[]): GateResult {
  const failures = marks.flatMap((measure) => markFailures(filmId, measure));
  const frames = new Set(marks.map(({ frame }) => frame));
  const matched = marks.filter((measure): measure is Matched => measure.outside === null);
  const lowest = lowestBy(matched, ({ iou }) => iou);
  const counted = `${plural(marks.length, 'resting mark', 'resting marks')} on ${plural(frames.size, 'frame', 'frames')}`;
  if (marks.length === 0) {
    return gateResult('logo', failures, ['no compared frame reports a resting mark']);
  }
  if (lowest === null) {
    return gateResult('logo', failures, [`${counted}; none could be matched`]);
  }
  return gateResult('logo', failures, [
    `${counted}; lowest IoU ${lowest.iou.toFixed(5)} (${where(lowest)})`,
    ...lookLines(matched),
  ]);
}
