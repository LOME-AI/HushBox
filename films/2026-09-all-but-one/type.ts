import { SAFE_BOX } from '../engine/layout/index.js';

import { CX, clamp, hs, rgba, springOf } from './kit.js';

import type { G } from './kit.js';
import type { LookContext, TextBox } from '../engine/look/index.js';

type Ctx = LookContext<'2d'>;

/** A copy row as the spec resolves it. */
export interface Row {
  id: string;
  words: string;
  role: TextBox['role'];
  from: number;
  to: number;
}

export interface RowStyle {
  face: 'sans' | 'serif' | 'mono';
  weight: number;
  /** The size it is set at when it fits; never set below its role's floor. */
  size: number;
  color: string;
  /** Tracking in em at rest. */
  tracking: number;
  /** A second colour laid under the glyphs as an offset shadow, or null. */
  shadow: string | null;
}

const FLOOR: Record<TextBox['role'], number> = { headline: 84, cta: 84, support: 44, imagery: 1 };
/** Copy never grows past this width, so its arrival overshoot stays inside the safe box. */
const MAX_W = SAFE_BOX.width - 24;
const LINE_GAP = 0.2;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The smallest rect holding every corner-pair extent given. */
export function boundsOf(
  extents: readonly { x0: number; y0: number; x1: number; y1: number }[]
): Rect {
  const x0 = Math.min(...extents.map((e) => e.x0));
  const y0 = Math.min(...extents.map((e) => e.y0));
  const x1 = Math.max(...extents.map((e) => e.x1));
  const y1 = Math.max(...extents.map((e) => e.y1));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A local rect carried into frame pixels by the transform `t`, as the box holding its four corners. */
export function frameBox(
  t: DOMMatrix,
  { x0, y0, x1, y1 }: { x0: number; y0: number; x1: number; y1: number }
): Rect {
  const corners = [
    t.transformPoint({ x: x0, y: y0 }),
    t.transformPoint({ x: x1, y: y0 }),
    t.transformPoint({ x: x0, y: y1 }),
    t.transformPoint({ x: x1, y: y1 }),
  ];
  return boundsOf([
    {
      x0: Math.min(...corners.map((c) => c.x)),
      y0: Math.min(...corners.map((c) => c.y)),
      x1: Math.max(...corners.map((c) => c.x)),
      y1: Math.max(...corners.map((c) => c.y)),
    },
  ]);
}

/** A box grown by a pixel on every side, so it holds the antialiased edge of the ink it bounds. */
export function padded(box: Rect): Rect {
  return { x: box.x - 1, y: box.y - 1, width: box.width + 2, height: box.height + 2 };
}

/** How far inside the safe box's edges a moved box comes to rest, so rounding never leaves it on the line. */
const SAFE_INSET = 1;

/** The shift along one axis that puts the span `[from, from + length)` inside `[lo, lo + span]`, inset from its edges. */
function shiftInto(
  [from, length]: readonly [number, number],
  [lo, span]: readonly [number, number]
): number {
  if (from < lo) {
    return lo + SAFE_INSET - from;
  }
  return from + length > lo + span ? lo + span - SAFE_INSET - (from + length) : 0;
}

/**
 * The shift that puts a box no larger than the safe box inside it, a pixel clear of its edges;
 * zero on an axis the box already fits.
 */
export function intoSafeBox(box: Rect): [number, number] {
  return [
    shiftInto([box.x, box.width], [SAFE_BOX.x, SAFE_BOX.width]),
    shiftInto([box.y, box.height], [SAFE_BOX.y, SAFE_BOX.height]),
  ];
}

export function fontOf(ctx: Ctx, face: RowStyle['face'], weight: number, size: number): string {
  const stack = ctx.fonts[face];
  if (stack === undefined) {
    throw new Error(`2026-09-all-but-one: the look host loaded no ${face} stack`);
  }
  return `${String(weight)} ${String(size)}px ${stack}`;
}

interface Laid {
  row: Row;
  style: RowStyle;
  size: number;
  lines: string[];
  top: number;
  height: number;
}

/** Breaks words into lines no wider than the copy width at the context's current font. */
function wrap(g: G, words: string): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of words.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && g.measureText(next).width > MAX_W) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  out.push(line);
  return out;
}

/** Every row of a shot laid out top down from `top`, whether or not it has arrived, so no row jumps. */
function layout(
  g: G,
  ctx: Ctx,
  {
    rows,
    styleOf,
    top,
    gap,
  }: { rows: readonly Row[]; styleOf: (row: Row) => RowStyle; top: number; gap: number }
): Laid[] {
  let y = top;
  return rows.map((row) => {
    const style = styleOf(row);
    let size = style.size;
    g.font = fontOf(ctx, style.face, style.weight, size);
    g.letterSpacing = `${String(style.tracking * size)}px`;
    const width = g.measureText(row.words).width;
    if (width > MAX_W) {
      size = Math.max(FLOOR[row.role], Math.floor((size * MAX_W) / width) - 2);
      g.font = fontOf(ctx, style.face, style.weight, size);
      g.letterSpacing = `${String(style.tracking * size)}px`;
    }
    const lines = wrap(g, row.words);
    const height = size * (lines.length + (lines.length - 1) * LINE_GAP);
    const laid = { row, style, size, lines, top: y, height };
    y += height + gap;
    return laid;
  });
}

/**
 * The shot's copy, slammed in word row by word row: each arrives on its frame
 * with a horizontal smear and letters that converge from wide tracking, then
 * overshoots below full size, settles and keeps drifting. Returns the boxes drawn.
 */
/** The row arrival's spring: it undershoots to about 0.9 of full size once, then settles. */
const ARRIVAL = { hz: 2.4, damp: 5 };

export function drawRows(
  g: G,
  ctx: Ctx,
  {
    frame,
    rows,
    styleOf,
    options,
  }: {
    frame: number;
    rows: readonly Row[];
    styleOf: (row: Row) => RowStyle;
    options: {
      top: number;
      gap?: number;
      shake?: number;
      drift?: number;
      firstFrame?: number;
      exit?: number;
    };
  }
): TextBox[] {
  const laid = layout(g, ctx, { rows, styleOf, top: options.top, gap: options.gap ?? 26 });
  const boxes: TextBox[] = [];
  g.save();
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const shown = laid.flatMap((item, index) =>
    frame < item.row.from || frame >= item.row.to ? [] : [posed(g, ctx, { item, index, options })]
  );
  // The rows of a shot move up or down together, so a row that grows past the safe box never runs into its neighbour;
  // each moves sideways on its own. Each moves only as far as it must, on the frames it would leave the safe box.
  const dy =
    shown.length === 0
      ? 0
      : intoSafeBox(
          boundsOf(
            shown.map(({ drawn }) => ({
              x0: drawn.x,
              y0: drawn.y,
              x1: drawn.x + drawn.width,
              y1: drawn.y + drawn.height,
            }))
          )
        )[1];
  for (const pose of shown) {
    const { item, placed, bx, drawn, scaleX, scaleY, u, ex, letterSpacing } = pose;
    const { row, style, size } = item;
    const [dx] = intoSafeBox(drawn);
    g.font = fontOf(ctx, style.face, style.weight, size);
    g.letterSpacing = letterSpacing;
    for (const { text, by } of placed) {
      g.save();
      g.translate(bx + dx, by + dy);
      g.scale(scaleX, scaleY);
      if (!ctx.hideText) {
        inkLine(g, text, { style, u, ex });
      }
      g.restore();
    }
    const box = { x: drawn.x + dx, y: drawn.y + dy, width: drawn.width, height: drawn.height };
    boxes.push({ id: row.id, text: row.words, box, fontSizePx: size, role: row.role });
    // The arrival smear and the exit ghosts are motion, not copy: they are reported as imagery around the row.
    const trail = trailBox(row, { box, size, u, ex, scaleX });
    if (trail !== null) {
      boxes.push(trail);
    }
  }
  g.restore();
  g.letterSpacing = '0px';
  return boxes;
}

/** One line of a row at the origin: its exit ghosts, its arrival smear, its shadow, then the line itself. */
function inkLine(
  g: G,
  text: string,
  { style, u, ex }: { style: RowStyle; u: number; ex: number }
): void {
  if (ex > 0) {
    for (let k = 3; k >= 1; k--) {
      g.fillStyle = rgba(style.color, 0.2 * ex);
      g.fillText(text, k * 34 * ex, 0);
    }
  }
  if (u < 7) {
    const smear = 1 - u / 7;
    for (let k = 3; k >= 1; k--) {
      g.fillStyle = rgba(style.color, 0.18 * smear);
      g.fillText(text, -k * 26 * smear, 0);
    }
  }
  if (style.shadow !== null) {
    g.fillStyle = style.shadow;
    g.fillText(text, 5, 5);
  }
  g.fillStyle = style.color;
  g.fillText(text, 0, 0);
}

/** The imagery box of a row's arrival smear and exit ghosts around its copy box; null on a frame with neither. */
function trailBox(
  row: Row,
  { box, size, u, ex, scaleX }: { box: Rect; size: number; u: number; ex: number; scaleX: number }
): TextBox | null {
  const behind = u < 7 ? 3 * 26 * (1 - u / 7) * scaleX : 0;
  const ahead = ex > 0 ? 3 * 34 * ex * scaleX : 0;
  if (!(behind > 0 || ahead > 0)) {
    return null;
  }
  return {
    id: `${row.id}-trail`,
    text: row.words,
    box: { x: box.x - behind, y: box.y, width: box.width + behind + ahead, height: box.height },
    fontSizePx: size,
    role: 'imagery',
  };
}

/** One row on this frame: its scale, shake and arrival or exit, each line placed, and the box its ink fills. */
interface Pose {
  item: Laid;
  placed: { text: string; by: number }[];
  bx: number;
  /** The ink's box, a pixel wider on every side for the antialiased edge. */
  drawn: { x: number; y: number; width: number; height: number };
  scaleX: number;
  scaleY: number;
  u: number;
  ex: number;
  letterSpacing: string;
}

function posed(
  g: G,
  ctx: Ctx,
  {
    item,
    index,
    options,
  }: {
    item: Laid;
    index: number;
    options: { shake?: number; drift?: number; firstFrame?: number; exit?: number };
  }
): Pose {
  const { time } = ctx;
  const { row, style, size, lines } = item;
  const arrival = row.from === (options.firstFrame ?? -1) ? row.from - 12 : row.from;
  const u = time - arrival;
  // A looser spring than the heavy preset, so the row visibly overshoots below full size before it settles.
  const settle = springOf(time, arrival, ARRIVAL);
  const tracking = style.tracking + 0.55 * Math.exp(-u / 4);
  g.font = fontOf(ctx, style.face, style.weight, size);
  const letterSpacing = `${String(tracking * size)}px`;
  g.letterSpacing = letterSpacing;
  const widest = Math.max(...lines.map((l) => g.measureText(l).width));
  const want = 1 + 0.3 * (1 - settle) + (options.drift ?? 0.025) * clamp((time - row.from) / 90);
  const scale = Math.min(want, MAX_W / Math.max(1, widest));
  // The exit: over the last frames before its cut the row stretches wide and collapses to a
  // line, smearing forward, at full colour, so it leaves with motion and never fades under its contrast.
  const exitFrames = options.exit ?? 6;
  const ex = exitFrames > 0 ? clamp((time - (row.to - exitFrames)) / exitFrames) : 0;
  const eased = ex * ex;
  const scaleX = Math.min(scale * (1 + 0.22 * eased), MAX_W / Math.max(1, widest));
  const scaleY = scale * (1 - 0.92 * eased);
  const shakeX = (options.shake ?? 0) * hs(Math.round(time) * 3 + index, 17);
  const shakeY = (options.shake ?? 0) * hs(Math.round(time) * 5 + index, 29);
  const cy = item.top + item.height / 2;
  const measured = lines.map((text, li) => {
    const baseline = item.top + size * (li * (1 + LINE_GAP)) + size * 0.86;
    return {
      text,
      m: g.measureText(text),
      by: cy + (baseline - cy) * scaleY + shakeY - 14 * eased,
    };
  });
  const bx = CX + shakeX;
  const ink = boundsOf(
    measured.map(({ m, by }) => ({
      x0: bx - m.actualBoundingBoxLeft * scaleX,
      y0: by - m.actualBoundingBoxAscent * scaleY,
      x1: bx + m.actualBoundingBoxRight * scaleX,
      y1: by + m.actualBoundingBoxDescent * scaleY,
    }))
  );
  return {
    item,
    placed: measured.map(({ text, by }) => ({ text, by })),
    bx,
    drawn: padded(ink),
    scaleX,
    scaleY,
    u,
    ex,
    letterSpacing,
  };
}

/** One piece of imagery type (HUD, stamps, marquee words) drawn at a point and reported as a box. */
export function imagery(
  g: G,
  ctx: Ctx,
  spec: {
    id: string;
    text: string;
    x: number;
    y: number;
    size: number;
    face: RowStyle['face'];
    weight: number;
    fill?: string;
    stroke?: string;
    lineWidth?: number;
    align?: CanvasTextAlign;
    tracking?: number;
  }
): TextBox {
  g.save();
  g.font = fontOf(ctx, spec.face, spec.weight, spec.size);
  g.letterSpacing = `${String((spec.tracking ?? 0) * spec.size)}px`;
  g.textAlign = spec.align ?? 'left';
  g.textBaseline = 'alphabetic';
  const m = g.measureText(spec.text);
  if (!ctx.hideText) {
    if (spec.fill !== undefined) {
      g.fillStyle = spec.fill;
      g.fillText(spec.text, spec.x, spec.y);
    }
    if (spec.stroke !== undefined) {
      g.strokeStyle = spec.stroke;
      g.lineWidth = spec.lineWidth ?? 2;
      g.strokeText(spec.text, spec.x, spec.y);
    }
  }
  g.restore();
  g.letterSpacing = '0px';
  const t = g.getTransform();
  const box = frameBox(t, {
    x0: spec.x - m.actualBoundingBoxLeft,
    y0: spec.y - m.actualBoundingBoxAscent,
    x1: spec.x + m.actualBoundingBoxRight,
    y1: spec.y + m.actualBoundingBoxDescent,
  });
  return {
    id: spec.id,
    text: spec.text,
    box,
    fontSizePx: Math.max(1, spec.size * Math.hypot(t.a, t.b)),
    role: 'imagery',
  };
}
