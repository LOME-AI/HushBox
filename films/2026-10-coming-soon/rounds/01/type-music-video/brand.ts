import type { G } from './kit.js';
import type { Ctx } from './type.js';
import type { LogoBox } from '../../../../engine/look/index.js';

/** A brand colour as `#rrggbb`, whatever CSS colour syntax the stylesheet used. */
export function hex(css: string): string {
  const cached = HEX.get(css);
  if (cached !== undefined) {
    return cached;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (g === null) {
    throw new Error('type-music-video: no 2D context to resolve a brand colour');
  }
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gg = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
  const out = `#${((r << 16) | (gg << 8) | b).toString(16).padStart(6, '0')}`;
  HEX.set(css, out);
  return out;
}
const HEX = new Map<string, string>();

interface MarkPart {
  path: Path2D;
  cx: number;
  cy: number;
  dot: boolean;
}

let PARTS: { logo: Ctx['logo']; parts: MarkPart[] } | null = null;

/** The logo's traced parts from `ctx.logo`, each with its centroid; the part nearest the file's centre is the dot. */
function logoParts(ctx: Ctx): MarkPart[] {
  if (PARTS !== null && PARTS.logo === ctx.logo) {
    return PARTS.parts;
  }
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
  PARTS = { logo, parts };
  return parts;
}

export interface Place {
  x: number;
  y: number;
  size: number;
}

/**
 * The mark from the logo's own traced parts, each carried by `pose(i)`: `w`
 * its arrival (0 at the dot, 1 exactly at rest) and `spin` how far round it
 * swings on the way. At w = 1 every part sits at the file's own place.
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

/** The mark at rest, exactly the logo, and its box as the logo gate reads it: the whole image's box through the current transform. */
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
