import { TAU, boil, hash, lerp, rgba } from './kit.js';

import type { G, Pt } from './kit.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

/** The line's boil: how far, in px, every drawn point wanders when it re-rolls. */
export interface Boil {
  time: number;
  seed: number;
  amp: number;
}

/** A point nudged by the boil, seeded by its index. */
export function boiled(p: Pt, i: number, b: Boil | null): Pt {
  if (b === null || b.amp === 0) {
    return p;
  }
  return [p[0] + boil(b.time, i * 2, 8, b.seed) * b.amp, p[1] + boil(b.time, i * 2 + 1, 8, b.seed) * b.amp];
}

function trace(g: G, pts: readonly Pt[], b: Boil | null, closed = false): void {
  g.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = boiled(p, i, b);
    if (i === 0) {
      g.moveTo(x, y);
    } else {
      g.lineTo(x, y);
    }
  });
  if (closed) {
    g.closePath();
  }
}

/** A smooth path through the points: quadratic segments through their midpoints. */
export function traceSmooth(g: G, pts: readonly Pt[], b: Boil | null, closed = false): void {
  const q = pts.map((p, i) => boiled(p, i, b));
  const n = q.length;
  if (n < 3) {
    trace(g, pts, b, closed);
    return;
  }
  g.beginPath();
  if (closed) {
    const last = q[n - 1] as Pt;
    const first = q[0] as Pt;
    g.moveTo((last[0] + first[0]) / 2, (last[1] + first[1]) / 2);
    for (let i = 0; i < n; i++) {
      const p = q[i] as Pt;
      const nx = q[(i + 1) % n] as Pt;
      g.quadraticCurveTo(p[0], p[1], (p[0] + nx[0]) / 2, (p[1] + nx[1]) / 2);
    }
    g.closePath();
    return;
  }
  const first = q[0] as Pt;
  g.moveTo(first[0], first[1]);
  for (let i = 1; i < n - 1; i++) {
    const p = q[i] as Pt;
    const nx = q[i + 1] as Pt;
    g.quadraticCurveTo(p[0], p[1], (p[0] + nx[0]) / 2, (p[1] + nx[1]) / 2);
  }
  const last = q[n - 1] as Pt;
  g.lineTo(last[0], last[1]);
}

/** An inked line: a smooth stroke with round ends. */
export function line(g: G, pts: readonly Pt[], width: number, color: string, b: Boil | null = null, closed = false): void {
  traceSmooth(g, pts, b, closed);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = width;
  g.strokeStyle = color;
  g.stroke();
}

/**
 * A limb or a sleeve: a tube of `width` filled with `fill`, outlined in `ink`
 * `lw` wide, along the points. Drawn as two strokes, the outline under the fill.
 */
export function tube(g: G, pts: readonly Pt[], width: number, fill: string, ink: string, lw: number, b: Boil | null): void {
  const q = pts.map((p, i) => boiled(p, i, b));
  traceSmooth(g, q, null);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = width + lw * 2;
  g.strokeStyle = ink;
  g.stroke();
  g.lineWidth = width;
  g.strokeStyle = fill;
  g.stroke();
}

/** A shape filled and outlined: the closed smooth path through the points. */
export function blob(g: G, pts: readonly Pt[], fill: string | null, ink: string | null, lw: number, b: Boil | null): void {
  traceSmooth(g, pts, b, true);
  if (fill !== null) {
    g.fillStyle = fill;
    g.fill();
  }
  if (ink !== null) {
    g.lineJoin = 'round';
    g.lineWidth = lw;
    g.strokeStyle = ink;
    g.stroke();
  }
}

/** A closed polygon, straight edges, filled and outlined. */
export function poly(g: G, pts: readonly Pt[], fill: string | null, ink: string | null, lw: number, b: Boil | null): void {
  trace(g, pts, b, true);
  if (fill !== null) {
    g.fillStyle = fill;
    g.fill();
  }
  if (ink !== null) {
    g.lineJoin = 'round';
    g.lineWidth = lw;
    g.strokeStyle = ink;
    g.stroke();
  }
}

/** An ellipse as points, for boiled outlines. */
export function ellipsePts(cx: number, cy: number, rx: number, ry: number, n = 16, rot = 0): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * TAU;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)] as const;
  });
}

/** A rectangle's outline as points, with a midpoint on each side so the boil bends it. */
export function rectPts(x: number, y: number, w: number, h: number): Pt[] {
  return [
    [x, y],
    [x + w / 2, y],
    [x + w, y],
    [x + w, y + h / 2],
    [x + w, y + h],
    [x + w / 2, y + h],
    [x, y + h],
    [x, y + h / 2],
  ];
}

/** A hand-drawn rectangle: its edges boil, its corners stay sharp. */
export function sketchRect(g: G, x: number, y: number, w: number, h: number, fill: string | null, ink: string | null, lw: number, b: Boil | null): void {
  poly(g, rectPts(x, y, w, h), fill, ink, lw, b);
}

/** A rounded rectangle path. */
export function roundRect(g: G, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

/** A watercolour wash: the shape filled twice, a hair apart, so its edge reads as pooled pigment. */
export function wash(g: G, pts: readonly Pt[], color: string, alpha: number, b: Boil | null): void {
  traceSmooth(g, pts, b, true);
  g.fillStyle = rgba(color, alpha);
  g.fill();
  if (b !== null) {
    traceSmooth(g, pts.map(([x, y], i) => [x + 3 * Math.sin(i * 1.7 + b.seed), y + 3 * Math.cos(i * 2.3 + b.seed)] as const), b, true);
    g.fillStyle = rgba(color, alpha * 0.5);
    g.fill();
  }
}

/** A soft radial pool of light. */
export function glow(g: G, x: number, y: number, r: number, color: string, alpha: number, mode: GlobalCompositeOperation = 'lighter'): void {
  if (alpha <= 0 || r <= 0) {
    return;
  }
  g.save();
  g.globalCompositeOperation = mode;
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, rgba(color, alpha));
  grad.addColorStop(0.45, rgba(color, alpha * 0.4));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(x - r, y - r, r * 2, r * 2);
  g.restore();
}

/** The brand's font stack for a face, at a weight and size. */
export function fontOf(ctx: Ctx, face: 'sans' | 'serif' | 'mono', weight: number, size: number, italic = false): string {
  const stack = ctx.fonts[face];
  if (stack === undefined) {
    throw new Error(`storybook-short: the look host loaded no ${face} stack`);
  }
  return `${italic ? 'italic ' : ''}${String(weight)} ${String(size)}px ${stack}`;
}

/** The box a rect drawn under the current transform covers on the frame, and the scale it is drawn at. */
export function onFrame(g: G, x: number, y: number, w: number, h: number): { box: TextBox['box']; scale: number } {
  const m = g.getTransform();
  const corners = [
    m.transformPoint({ x, y }),
    m.transformPoint({ x: x + w, y }),
    m.transformPoint({ x, y: y + h }),
    m.transformPoint({ x: x + w, y: y + h }),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    box: { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top },
    scale: Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)),
  };
}

/** A copy text's box as the claims gate reads it, from its glyph extent under the current transform. */
export function copyBox(g: G, id: string, words: string, role: TextBox['role'], x: number, top: number, w: number, h: number, size: number): TextBox {
  const { box, scale } = onFrame(g, x, top, w, h);
  return { id, text: words, box, fontSizePx: size * scale, role };
}

/** Tiny illegible "writing": a few wavy ink lines in a box, as a page or message reads from afar. */
export function scribble(g: G, x: number, y: number, w: number, lines: number, gap: number, color: string, width: number, seed: number, b: Boil | null): void {
  for (let i = 0; i < lines; i++) {
    const len = w * (i === lines - 1 ? 0.35 + 0.4 * hash(i, seed) : 0.75 + 0.25 * hash(i, seed));
    const pts: Pt[] = [];
    const n = Math.max(3, Math.round(len / 18));
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      pts.push([x + len * u, y + i * gap + Math.sin(u * 9 + i * 2 + seed) * 2.2]);
    }
    line(g, pts, width, color, b);
  }
}

/** A path's points, sampled along a straight segment. */
export function seg(a: Pt, c: Pt, n: number): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => [lerp(a[0], c[0], i / n), lerp(a[1], c[1], i / n)] as const);
}
