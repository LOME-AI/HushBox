import { copyBox, fontOf } from './ink.js';
import { CX, H, PLAYFUL, SNAPPY, TAU, W, clamp, hash, hexOf, prog, rgba, smooth, spring, springOf } from './kit.js';
import { END, MARK, TAGLINE_AT, WORDMARK_AT } from './score.js';

import type { G, Pt } from './kit.js';
import type { LogoBox, LookBox, LookContext } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

interface MarkPart {
  path: Path2D;
  cx: number;
  cy: number;
  dot: boolean;
}

/** The logo's traced parts from `ctx.logo`, each with its centroid; the dot is the part nearest the centre. */
function logoParts(ctx: Ctx): MarkPart[] {
  const { logo } = ctx;
  const parts = logo.parts.map((part) => {
    const n = Math.max(1, part.outline.length);
    const cx = part.outline.reduce((sum, p) => sum + p.x, 0) / n;
    const cy = part.outline.reduce((sum, p) => sum + p.y, 0) / n;
    return { path: part.path, cx, cy, dot: false };
  });
  const off = (part: MarkPart): number => Math.hypot(part.cx - logo.width / 2, part.cy - logo.height / 2);
  const dot = parts.reduce<MarkPart | undefined>((best, part) => (best === undefined || off(part) < off(best) ? part : best), undefined);
  if (dot !== undefined) {
    dot.dot = true;
  }
  return parts;
}

export interface Place {
  x: number;
  y: number;
  size: number;
}

/**
 * The mark from the logo's own parts, each carried by `pose(i)`: `w` its
 * arrival (0 at the dot, 1 exactly at rest). At w = 1 every part is filled at
 * the file's own place, so the mark at rest is the logo exactly.
 */
export function drawMark(g: G, ctx: Ctx, place: Place, color: string, pose: (i: number, dot: boolean) => { w: number; spin: number }): void {
  const k = place.size / ctx.logo.width;
  const mx = ctx.logo.width / 2;
  const my = ctx.logo.height / 2;
  g.save();
  g.translate(place.x - mx * k, place.y - my * k);
  g.scale(k, k);
  g.fillStyle = color;
  logoParts(ctx).forEach((part, i) => {
    const { w, spin } = pose(i, part.dot);
    if (w <= 0 && !part.dot) {
      return;
    }
    const dx = part.cx - mx;
    const dy = part.cy - my;
    const a = spin * (1 - w);
    const px = mx + (dx * Math.cos(a) - dy * Math.sin(a)) * w;
    const py = my + (dx * Math.sin(a) + dy * Math.cos(a)) * w;
    const scale = 0.25 + 0.75 * Math.min(1.15, w);
    g.save();
    g.translate(px, py);
    g.rotate(a);
    g.scale(scale, scale);
    g.translate(-part.cx, -part.cy);
    g.fill(part.path);
    g.restore();
  });
  g.restore();
}

/** The mark at rest and its box as the logo gate reads it: the whole image's box through the current transform. */
export function markAtRest(g: G, ctx: Ctx, place: Place, color: string, id: string): LogoBox {
  drawMark(g, ctx, place, color, () => ({ w: 1, spin: 0 }));
  const k = place.size / ctx.logo.width;
  const x0 = place.x - (ctx.logo.width / 2) * k;
  const y0 = place.y - (ctx.logo.height / 2) * k;
  const m = g.getTransform();
  const a = m.transformPoint({ x: x0, y: y0 });
  const b = m.transformPoint({ x: x0 + ctx.logo.width * k, y: y0 + ctx.logo.height * k });
  return { id, box: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }, role: 'logo' };
}

/** The mark's place on the end card. */
export const END_MARK: Place = { x: CX, y: 590, size: 330 };

/** The end page: warm charcoal, the mark flying out of its dot and breathing, the wordmark and tagline rising in. */
export function drawEndPage(g: G, ctx: Ctx, time: number, frame: number): LookBox[] {
  const bg = hexOf(ctx.brand.background);
  const fg = hexOf(ctx.brand.foreground);
  const red = hexOf(ctx.brand.brandRed);
  g.fillStyle = bg;
  g.fillRect(-200, -200, W + 400, H + 400);
  const land = MARK;
  const rest = MARK + 18;
  // Near still: the page pushes in a hair, by scale only, so the mark at rest keeps its exact shape.
  const push = 1 + 0.018 * smooth(prog(time, rest, END));
  g.save();
  g.translate(CX, H / 2);
  g.scale(push, push);
  g.translate(-CX, -H / 2);
  const grad = g.createRadialGradient(END_MARK.x, END_MARK.y, 0, END_MARK.x, END_MARK.y, 760);
  grad.addColorStop(0, rgba(red, 0.08 + 0.02 * Math.sin(time * 0.06)));
  grad.addColorStop(1, rgba(red, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const boxes: LookBox[] = [];
  if (frame >= rest) {
    // The mark breathes: a slow swell of a percent or so, never frozen.
    const breath = 1 + 0.012 * Math.sin(((time - rest) / 100) * TAU);
    boxes.push(markAtRest(g, ctx, { ...END_MARK, size: END_MARK.size * breath }, red, 'end-mark'));
  } else if (time >= land - 12 && time < land) {
    // The dot drops onto the page as it turns, landing on the cut.
    const fall = 1 - prog(time, land - 12, land);
    drawMark(g, ctx, { ...END_MARK, size: END_MARK.size * (0.72 + 1.6 * fall * fall) }, red, (_, dot) => ({ w: dot ? 1 : 0, spin: 0 }));
  } else if (time >= land) {
    if (Math.round(time) < land + 24) {
      const w = (time - land) / 24;
      g.strokeStyle = rgba(red, 0.45 * (1 - w));
      g.lineWidth = 5;
      g.beginPath();
      g.arc(END_MARK.x, END_MARK.y, 30 + END_MARK.size * 0.7 * w, 0, TAU);
      g.stroke();
    }
    // The whole mark pops past its size as the arcs fly out, and is exactly at rest on `rest`.
    const into = smooth(clamp((rest - time) / 8));
    const pop = 1 + (0.72 + 0.28 * Math.max(0, springOf(time, land - 2, PLAYFUL)) - 1) * into;
    drawMark(g, ctx, { ...END_MARK, size: END_MARK.size * pop }, red, (i, dot) => {
      const w = dot ? 1 : Math.max(0, springOf(time, land + i * 1.2, SNAPPY));
      return { w: Math.min(w, 1 + (w - 1) * into), spin: 1.3 + 0.2 * (i % 3) };
    });
  }
  for (const [n, row] of END_ROWS.entries()) {
    const at = row.at;
    const start = at - 3;
    if (time < start) {
      continue;
    }
    // Each line springs up from below, past its place and its size, and settles; stretched while it moves fast.
    // The tagline's later lines spring a little slower, so they land one after another.
    const hz = 2.7 - 0.35 * Math.max(0, n - 1);
    const k = spring(time, start, hz, 6.2);
    const v = k - spring(time - 1, start, hz, 6.2);
    const y = row.y + 90 * (1 - k);
    const sc = 0.7 + 0.3 * k;
    const sy = 1 + clamp(1.6 * v, -0.2, 0.3);
    const sx = 1 - clamp(0.8 * v, -0.1, 0.15);
    g.save();
    g.globalAlpha = clamp((time - start) / 3);
    g.font = fontOf(ctx, row.face, row.weight, row.size);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    const parts = row.parts.map((p) => ({ ...p, w: g.measureText(p.text).width }));
    const width = parts.reduce((s, p) => s + p.w, 0);
    const m = g.measureText(row.words);
    if (!ctx.hideText) {
      g.save();
      g.translate(CX, y);
      g.scale(sc * sx, sc * sy);
      let x = -width / 2;
      for (const p of parts) {
        g.fillStyle = p.color === 'red' ? red : fg;
        g.fillText(p.text, x, 0);
        x += p.w;
      }
      g.restore();
    }
    g.restore();
    if (frame >= at) {
      const ascent = m.actualBoundingBoxAscent;
      const descent = m.actualBoundingBoxDescent;
      boxes.push(copyBox(g, row.id, row.words, 'headline', CX - width / 2, row.y - ascent, width, ascent + descent, row.size));
    }
  }
  g.restore();
  return boxes;
}

interface EndRow {
  id: string;
  words: string;
  /** The frame the row lands on: its spring starts a few frames before. */
  at: number;
  y: number;
  face: 'sans' | 'serif';
  weight: number;
  size: number;
  parts: { text: string; color: 'fg' | 'red' }[];
}

const END_ROWS: EndRow[] = [
    { id: 'wordmark', words: 'HushBox', at: WORDMARK_AT, y: 905, face: 'serif', weight: 700, size: 132, parts: [{ text: 'Hush', color: 'fg' }, { text: 'Box', color: 'red' }] },
    { id: 'tag-1', words: 'One interface.', at: TAGLINE_AT, y: 1030, face: 'sans', weight: 700, size: 86, parts: [{ text: 'One interface.', color: 'fg' }] },
    { id: 'tag-2', words: 'Every feature.', at: TAGLINE_AT, y: 1122, face: 'sans', weight: 700, size: 86, parts: [{ text: 'Every feature.', color: 'fg' }] },
    { id: 'tag-3', words: 'Private.', at: TAGLINE_AT, y: 1214, face: 'sans', weight: 700, size: 86, parts: [{ text: 'Private.', color: 'red' }] },
];

/**
 * A page turning from the bottom-right corner toward the top left: the page's
 * remaining part is drawn by `drawPage`, clipped; the turned flap, its back
 * cream paper, lies reflected over it with a soft shadow under the fold.
 */
export function pageTurn(g: G, u: number, drawPage: () => void): void {
  const d: Pt = [-0.88, -0.48];
  const corner: Pt = [W, H];
  // Far enough that at u = 1 the fold has passed the page's opposite corner.
  const reach = u * (W * 0.88 + H * 0.48 + 80);
  const p: Pt = [corner[0] + d[0] * reach, corner[1] + d[1] * reach];
  // Region still flat: points on the far side of the fold from the corner.
  const n: Pt = [-d[1], d[0]];
  const big = 4000;
  const flat: Pt[] = [
    [p[0] + n[0] * big, p[1] + n[1] * big],
    [p[0] - n[0] * big, p[1] - n[1] * big],
    [p[0] - n[0] * big + d[0] * big, p[1] - n[1] * big + d[1] * big],
    [p[0] + n[0] * big + d[0] * big, p[1] + n[1] * big + d[1] * big],
  ];
  g.save();
  g.beginPath();
  flat.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  g.closePath();
  g.clip();
  drawPage();
  g.restore();
  // The flap: the turned part of the page, reflected over the fold.
  const pageCorners: Pt[] = [[0, 0], [W, 0], [W, H], [0, H]];
  const turned = clipPolygon(pageCorners, p, d);
  if (turned.length < 3) {
    return;
  }
  const reflect = ([x, y]: Pt): Pt => {
    const t = (x - p[0]) * d[0] + (y - p[1]) * d[1];
    return [x - 2 * t * d[0], y - 2 * t * d[1]];
  };
  const flap = turned.map(reflect);
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 40;
  g.beginPath();
  flap.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  g.closePath();
  const grad = g.createLinearGradient(p[0], p[1], p[0] + d[0] * 600, p[1] + d[1] * 600);
  grad.addColorStop(0, '#e8dcc4');
  grad.addColorStop(1, '#f7efdf');
  g.fillStyle = grad;
  g.fill();
  g.restore();
  g.strokeStyle = '#2b211c';
  g.lineWidth = 3;
  g.beginPath();
  flap.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  g.closePath();
  g.stroke();
  void hash;
}

/** The part of a convex polygon on the corner's side of the fold through `p` across direction `d`. */
function clipPolygon(poly: readonly Pt[], p: Pt, d: Pt): Pt[] {
  const side = ([x, y]: Pt): number => (x - p[0]) * d[0] + (y - p[1]) * d[1];
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Pt;
    const b = poly[(i + 1) % poly.length] as Pt;
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) {
      out.push(a);
    }
    if ((sa <= 0) !== (sb <= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
