import { SAFE_BOX } from '../../../../engine/layout/index.js';

import { CX, HEAVY, clamp, hs, rgba, springOf } from './kit.js';

import type { G } from './kit.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

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

export function fontOf(ctx: Ctx, face: RowStyle['face'], weight: number, size: number): string {
  const stack = ctx.fonts[face];
  if (stack === undefined) {
    throw new Error(`beat-cut-video: the look host loaded no ${face} stack`);
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
function layout(g: G, ctx: Ctx, rows: readonly Row[], styleOf: (row: Row) => RowStyle, top: number, gap: number): Laid[] {
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
 * settles on a heavy spring and keeps drifting. Returns the boxes drawn.
 */
export function drawRows(
  g: G,
  ctx: Ctx,
  frame: number,
  rows: readonly Row[],
  styleOf: (row: Row) => RowStyle,
  opts: { top: number; gap?: number; shake?: number; drift?: number; firstFrame?: number; exit?: number }
): TextBox[] {
  const { time } = ctx;
  const laid = layout(g, ctx, rows, styleOf, opts.top, opts.gap ?? 26);
  const boxes: TextBox[] = [];
  g.save();
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  for (const [index, item] of laid.entries()) {
    const { row, style, size, lines } = item;
    if (frame < row.from || frame >= row.to) {
      continue;
    }
    const arrival = row.from === (opts.firstFrame ?? -1) ? row.from - 12 : row.from;
    const u = time - arrival;
    const settle = springOf(time, arrival, HEAVY);
    const tracking = style.tracking + 0.55 * Math.exp(-u / 4);
    g.font = fontOf(ctx, style.face, style.weight, size);
    g.letterSpacing = `${String(tracking * size)}px`;
    const widest = Math.max(...lines.map((l) => g.measureText(l).width));
    const want = 1 + 0.16 * (1 - settle) + (opts.drift ?? 0.025) * clamp((time - row.from) / 90);
    const scale = Math.min(want, MAX_W / Math.max(1, widest));
    // The exit: over the last frames before its cut the row stretches wide and collapses to a
    // line, smearing forward, at full colour, so it leaves with motion and never fades under its contrast.
    const exitFrames = opts.exit ?? 6;
    const ex = exitFrames > 0 ? clamp((time - (row.to - exitFrames)) / exitFrames) : 0;
    const eased = ex * ex;
    const scaleX = Math.min(scale * (1 + 0.22 * eased), MAX_W / Math.max(1, widest));
    const scaleY = scale * (1 - 0.92 * eased);
    const shakeX = (opts.shake ?? 0) * hs(Math.floor(time) * 3 + index, 17);
    const shakeY = (opts.shake ?? 0) * hs(Math.floor(time) * 5 + index, 29);
    const cy = item.top + item.height / 2;
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let upper = Number.POSITIVE_INFINITY;
    let lower = Number.NEGATIVE_INFINITY;
    for (const [li, text] of lines.entries()) {
      const baseline = item.top + size * (li * (1 + LINE_GAP)) + size * 0.86;
      const m = g.measureText(text);
      const bx = CX + shakeX;
      const by = cy + (baseline - cy) * scaleY + shakeY - 14 * eased;
      g.save();
      g.translate(bx, by);
      g.scale(scaleX, scaleY);
      if (!ctx.hideText) {
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
      g.restore();
      left = Math.min(left, bx - m.actualBoundingBoxLeft * scaleX);
      right = Math.max(right, bx + m.actualBoundingBoxRight * scaleX);
      upper = Math.min(upper, by - m.actualBoundingBoxAscent * scaleY);
      lower = Math.max(lower, by + m.actualBoundingBoxDescent * scaleY);
    }
    boxes.push({
      id: row.id,
      text: row.words,
      box: { x: left, y: upper, width: right - left, height: lower - upper },
      fontSizePx: size,
      role: row.role,
    });
  }
  g.restore();
  g.letterSpacing = '0px';
  return boxes;
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
  const x0 = spec.x - m.actualBoundingBoxLeft;
  const y0 = spec.y - m.actualBoundingBoxAscent;
  const x1 = spec.x + m.actualBoundingBoxRight;
  const y1 = spec.y + m.actualBoundingBoxDescent;
  const corners = [
    t.transformPoint({ x: x0, y: y0 }),
    t.transformPoint({ x: x1, y: y0 }),
    t.transformPoint({ x: x0, y: y1 }),
    t.transformPoint({ x: x1, y: y1 }),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const bx = Math.min(...xs);
  const by = Math.min(...ys);
  return {
    id: spec.id,
    text: spec.text,
    box: { x: bx, y: by, width: Math.max(...xs) - bx, height: Math.max(...ys) - by },
    fontSizePx: Math.max(1, spec.size * Math.hypot(t.a, t.b)),
    role: 'imagery',
  };
}
