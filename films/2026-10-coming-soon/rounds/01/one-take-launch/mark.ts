import type { G } from './kit.js';
import type { LogoBox, LookContext } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

interface MarkPart {
  path: Path2D;
  /** The part's centroid in the logo file's pixel space. */
  cx: number;
  cy: number;
  /** True for the centre dot: the part nearest the file's centre. */
  dot: boolean;
}

let cached: { logo: Ctx['logo']; parts: MarkPart[] } | null = null;

/** The logo's traced parts from `ctx.logo`, each with its centroid; the arcs listed in turn round the dot. */
function logoParts(ctx: Ctx): MarkPart[] {
  if (cached !== null && cached.logo === ctx.logo) {
    return cached.parts;
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
  const angle = (part: MarkPart): number => Math.atan2(part.cy - logo.height / 2, part.cx - logo.width / 2);
  const ordered = parts.toSorted((a, b) => (a.dot ? -1 : b.dot ? 1 : angle(a) - angle(b)));
  cached = { logo, parts: ordered };
  return ordered;
}

/** Where the mark sits: its centre and its width, in the current transform's units. */
export interface MarkPlace {
  x: number;
  y: number;
  size: number;
}

/**
 * The mark from the logo's traced parts. `pose(i, dot)` carries each part: `w`
 * its arrival (0 far out on its swirl, 1 exactly at rest). At w = 1 every part
 * is drawn at the file's own place, so the mark at rest is the logo exactly.
 */
export function drawMark(
  g: G,
  ctx: Ctx,
  place: MarkPlace,
  color: string,
  pose: (i: number, dot: boolean) => number
): void {
  const k = place.size / ctx.logo.width;
  const mx = ctx.logo.width / 2;
  const my = ctx.logo.height / 2;
  g.save();
  g.translate(place.x - mx * k, place.y - my * k);
  g.scale(k, k);
  g.fillStyle = color;
  logoParts(ctx).forEach((part, i) => {
    const w = pose(i, part.dot);
    if (w <= 0) {
      return;
    }
    if (w === 1) {
      g.fill(part.path);
      return;
    }
    const dx = part.cx - mx;
    const dy = part.cy - my;
    // Each arc swings in round the centre from further out, a quarter turn behind its place.
    const a = -1.6 * (1 - w);
    const r = 1 + 1.4 * (1 - w);
    const px = mx + (dx * Math.cos(a) - dy * Math.sin(a)) * r;
    const py = my + (dx * Math.sin(a) + dy * Math.cos(a)) * r;
    const scale = part.dot ? Math.min(1.2, w) : 0.4 + 0.6 * Math.min(1.1, w);
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

/** How many parts the mark has, so a caller can stagger them. */
export function markPartCount(ctx: Ctx): number {
  return logoParts(ctx).length;
}

/**
 * The mark at rest, exactly the logo, and its box as the logo gate reads it: the
 * whole logo image's box through the current transform, which must be scale and
 * translation only.
 */
export function markAtRest(g: G, ctx: Ctx, place: MarkPlace, color: string, id: string): LogoBox {
  drawMark(g, ctx, place, color, () => 1);
  const k = place.size / ctx.logo.width;
  const x0 = place.x - (ctx.logo.width / 2) * k;
  const y0 = place.y - (ctx.logo.height / 2) * k;
  const m = g.getTransform();
  const a = m.transformPoint({ x: x0, y: y0 });
  const b = m.transformPoint({ x: x0 + ctx.logo.width * k, y: y0 + ctx.logo.height * k });
  return { id, box: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }, role: 'logo' };
}
