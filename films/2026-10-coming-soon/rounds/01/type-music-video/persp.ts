import { P, W, hash, rgba, wander } from './kit.js';
import { glyph } from './type.js';

import type { G } from './kit.js';
import type { Ctx } from './type.js';

/** A pinhole camera over a ground plane: focal length in pixels, horizon row, eye height and how far it has moved forward. */
export interface Persp {
  f: number;
  cx: number;
  /** The horizon's row on screen. */
  y0: number;
  /** Eye height above the ground, in world units. */
  h: number;
  /** The eye's depth: everything is seen from here. */
  z0: number;
}

/** A world point (X across, Y up, Z ahead) on screen, with the pixels one world unit spans there; null behind the eye. */
export function project(p: Persp, x: number, y: number, z: number): { x: number; y: number; s: number } | null {
  const d = z - p.z0;
  if (d <= 0.25) {
    return null;
  }
  return { x: p.cx + (p.f * x) / d, y: p.y0 + (p.f * (p.h - y)) / d, s: p.f / d };
}

/** A night sky: indigo to ink, stars of asterisks and middle dots twinkling on their own phases, and a C for the moon. */
export function nightSky(g: G, ctx: Ctx, time: number, horizon: number, opts: { moonX?: number; moonY?: number; drift?: number; count?: number } = {}): void {
  const grad = g.createLinearGradient(0, -200, 0, horizon + 200);
  grad.addColorStop(0, P.ink);
  grad.addColorStop(1, P.night2);
  g.fillStyle = grad;
  g.fillRect(-400, -400, W + 800, horizon + 600);
  const drift = opts.drift ?? 0;
  const count = opts.count ?? 46;
  for (let k = 0; k < count; k++) {
    const x = hash(k, 61) * (W + 200) - 100;
    const y = ((hash(k, 62) * (horizon + 200) + drift * (0.4 + hash(k, 63))) % (horizon + 200)) - 100;
    const tw = 0.35 + 0.65 * Math.abs(Math.sin(time * (0.03 + 0.04 * hash(k, 64)) + k));
    const ch = k % 5 === 0 ? '*' : k % 3 === 0 ? '+' : '·';
    glyph(g, ctx, ch, x, y, ch === '·' ? 46 : 26, { face: 'sans', weight: 500, color: P.cream, alpha: 0.55 * tw });
  }
  if (opts.moonX !== undefined) {
    glyph(g, ctx, 'C', opts.moonX, opts.moonY ?? 300, 150, { face: 'sans', weight: 900, color: P.amberHot, rot: -0.5 + 0.03 * wander(time / 60, 5) });
  }
}

/** A lamp: an f standing on the ground, its arm towards the road, a warm glow at its hook. */
export function lamp(g: G, ctx: Ctx, x: number, y: number, s: number, grow: number, mirror: boolean, glow: number): void {
  if (grow <= 0) {
    return;
  }
  const size = 2.4 * s;
  glyph(g, ctx, 'f', x, y, size, { face: 'sans', weight: 300, color: '#c9c2f0', sy: grow, sx: mirror ? -1 : 1, anchor: 'bottom' });
  const hx = x + (mirror ? -1 : 1) * size * 0.2;
  const hy = y - size * 0.72 * grow;
  if (glow > 0) {
    const r = s * 1.1;
    const halo = g.createRadialGradient(hx, hy, 0, hx, hy, r);
    halo.addColorStop(0, rgba(P.amberHot, 0.55 * glow));
    halo.addColorStop(0.3, rgba(P.amber, 0.22 * glow));
    halo.addColorStop(1, rgba(P.amber, 0));
    g.fillStyle = halo;
    g.fillRect(hx - r, hy - r, 2 * r, 2 * r);
    glyph(g, ctx, 'o', hx, hy + s * 0.08, s * 0.32, { face: 'sans', weight: 900, color: P.amberHot, alpha: glow });
  }
}
