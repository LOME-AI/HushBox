import { drawDevil } from './devil.js';
import { drawSearchField, fieldTarget } from './field-search.js';
import { drawFlame } from './fire.js';
import { drawFlock, haloDemon } from './flock.js';
import { CX, FPB, H, INK, TAU, W, bf, beatPulse, clamp, hash, lerp, prog, rgba, smooth, wander } from './kit.js';
import { field } from './scenes-praise.js';

import type { G } from './kit.js';
import type { LookContext } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

/** Drifting smoke, rising on its own slow cycles behind the laugh. */
function smoke(g: G, time: number, color: string, alpha: number): void {
  const t = time / 60;
  for (let i = 0; i < 14; i++) {
    const life = (t * (0.08 + 0.05 * hash(i, 31)) + hash(i, 32)) % 1;
    const x = hash(i, 33) * W + Math.sin(t * 0.7 + i) * 60;
    const y = H + 200 - life * (H + 600);
    const r = 220 + 260 * hash(i, 34);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, rgba(color, alpha * Math.sin(Math.PI * life)));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
}

/** The beat the laugh stops dead: the kit cuts out and the braam rings on. */
export const LAUGH_FREEZE_BEAT = 33.75;
/** The beat his collection starts to spread into the search field; it takes one beat. */
export const LAUGH_EASE_BEAT = 34;
const FREEZE = bf(LAUGH_FREEZE_BEAT);
const EASE = bf(LAUGH_EASE_BEAT);

/**
 * Beats 32-35: the flock merges into the Devil's laughing face; flames burst from his horns and
 * the demons he has gathered ring him, one slot in the ring empty. On 33.75 everything stops
 * dead. From 34 his collection spreads: each demon of the halo flies out and becomes a gold mark
 * of the search field, the empty slot flying to the one dark mark, hundreds more light around
 * them, and his face grows vast and dims behind them, landing exactly on the next shot.
 */
export function laugh(g: G, ctx: Ctx, now: number, start: number, frame: number): void {
  const run = frame >= FREEZE ? FREEZE : now;
  const e = smooth(prog(now, EASE, EASE + FPB));
  const lt = run - start;
  field(g, now, INK, lerp(1250, 1100, e), lerp(0.6, 0.4, e));
  smoke(g, run, '#3a1a06', 0.35 * (1 - e));
  // The last of the flock, still merging into the face on the shot's first frames.
  drawFlock(g, now);
  const grow = clamp(lt / 12);
  const tighten = 1 - 0.25 * prog(run, start, start + 72);
  const orbit = (i: number, tt: number): [number, number, number] => {
    const speed = 0.028 + 0.016 * hash(i, 41);
    const a = (i / 12) * TAU + (tt - start) * speed + 0.3 * wander(tt / 60, i + 20);
    const rx = 470 * tighten * (0.82 + 0.3 * hash(i, 42));
    const ry = 150 * tighten * (0.8 + 0.4 * hash(i, 43));
    const bob = 34 * Math.sin((tt / 60) * (1.3 + hash(i, 44)) + i * 1.7);
    return [CX + Math.cos(a) * rx, 1360 - 380 + Math.sin(a) * ry + bob, a];
  };
  // Slot 0 of the ring is empty: the one company missing from his collection.
  const halo = Array.from({ length: 11 }, (_, k) => {
    const i = k + 1;
    const [x, y, a] = orbit(i, run);
    const [fx, fy] = fieldTarget(i);
    return { x: lerp(x, fx, e), y: lerp(y, fy, e), a, i, back: Math.sin(a) < 0 };
  });
  const draw = (back: boolean): void => {
    for (const h of halo.filter((q) => q.back === back)) {
      const size = (back ? 0.5 : 0.8) * (0.85 + 0.3 * hash(h.i, 46)) * (1 + 0.2 * beatPulse(run - h.i * 3)) * grow;
      g.save();
      g.globalAlpha = 1 - e;
      haloDemon(g, h.i + 3, run, h.x, h.y, lerp(size, 0.2, e), 0.3 * Math.cos(h.a) * (1 - e), 1);
      g.restore();
    }
  };
  if (e <= 0) {
    draw(true);
  }
  const flare = beatPulse(run, FPB / 2, 3);
  const scale = lerp(290 + lt * 0.35, 620, e);
  const hx = CX;
  const hy = lerp(1360, 1060, e);
  for (const side of [-1, 1]) {
    drawFlame(g, run + side * 17, {
      x: hx + side * 0.7 * scale,
      y: hy - 1.85 * scale,
      height: (110 + 110 * flare) * (1 - e) * grow,
      width: 60,
      split: 0,
      heat: 1 - e,
      particles: 80,
      seed: side > 0 ? 71 : 73,
    });
  }
  if (e > 0) {
    // His collection spreads into the field: the next shot's picture, fading up under the flying halo.
    drawSearchField(g, ctx, now, e, { mood: 0.8, jaw: 0.15, look: 0 });
  }
  const laughJaw = 0.25 + 0.75 * Math.abs(Math.sin((Math.PI * (run - start)) / (FPB / 2)));
  g.save();
  g.globalAlpha = lerp(1, 0.22, e) * (e > 0 ? 1 - e : 1);
  drawDevil(g, run, {
    x: hx,
    y: hy,
    scale,
    // The face draws on out of the merging flock.
    draw: clamp(0.25 + lt / 10),
    mood: lerp(1, 0.8, e),
    jaw: lerp(laughJaw, 0.15, e),
    tremble: lerp(0.004, 0.003, e),
    horns: 1,
    line: INK.line,
    eye: INK.key,
    fill: INK.bg,
    lineWidth: lerp(4.5, 5, e),
    look: 0,
    tilt: 0.04 * Math.sin((Math.PI * (run - start)) / FPB) * (1 - e),
  });
  g.restore();
  draw(e > 0);
  if (e > 0) {
    draw(false);
  }
}
