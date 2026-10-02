// The build to the leak, staged after round 1's one-take-launch take: the watching eye shuts
// into a seam of light, the seam kinks into a crack that opens on each hit, draws in on the
// silence, and bursts on the drop, where the flock escapes (flock.ts). No message is readable
// before the flock: the flock carries the secrets.
import { H, INK, SNAPPY, SURV, W, bf, clamp, hash, lerp, rgba, springOf } from './kit.js';
import { SEAM_Y } from './flock.js';
import { eye, field } from './scenes-praise.js';

import type { G } from './kit.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

const SHUT = bf(19);
const KINK = bf(20);
const LIGHT = '#fff3d6';

/** A step toward `to` on each key's beat, springing: the crack's width and its branches' reach. */
function stepped(time: number, from: number, keys: readonly (readonly [number, number])[]): number {
  let value = from;
  let previous = from;
  for (const [at, to] of keys) {
    value += (to - previous) * springOf(time, at, SNAPPY);
    previous = to;
  }
  return value;
}

/** The crack's centre line at x: a zig-zag that kinks in on 20. */
function crackY(x: number, time: number): number {
  const kink = clamp(springOf(time, KINK, SNAPPY), 0, 1.2);
  const n = 11;
  const u = clamp((x - 60) / 960, 0, 0.9999);
  const k = Math.floor(u * n);
  const f = u * n - k;
  const hA = (k % 2 === 0 ? 1 : -1) * (0.5 + hash(k, 7));
  const hB = ((k + 1) % 2 === 0 ? 1 : -1) * (0.5 + hash(k + 1, 7));
  return SEAM_Y + lerp(hA, hB, f) * 42 * kink;
}

/** The seam once the lids have shut: a white-hot line that kinks, opens on each hit, grows branches, and draws in on the silence. */
function drawCrack(g: G, time: number): void {
  // Keyed to the whole frame, so each hit's opening lands complete on its frame under motion blur.
  const t = Math.round(time);
  const gap = stepped(t, 4, [
    [KINK, 26],
    [bf(22), 60],
    [bf(23), 120],
    [bf(23.5), 10],
  ]);
  const n = 48;
  const top: [number, number][] = [];
  const bottom: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const x = -400 + (i / n) * (W + 800);
    const y = crackY(x, t);
    top.push([x, y - gap / 2]);
    bottom.push([x, y + gap / 2]);
  }
  // The light spilling out of it.
  const glow = g.createLinearGradient(0, SEAM_Y - 260, 0, SEAM_Y + 260);
  glow.addColorStop(0, rgba(INK.key, 0));
  glow.addColorStop(0.5, rgba(INK.key, clamp(gap / 200) * 0.5));
  glow.addColorStop(1, rgba(INK.key, 0));
  g.fillStyle = glow;
  g.fillRect(-400, SEAM_Y - 260, W + 800, 520);
  drawRays(g, t);
  g.beginPath();
  top.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  for (let i = bottom.length - 1; i >= 0; i--) {
    const p = bottom[i];
    if (p !== undefined) {
      g.lineTo(p[0], p[1]);
    }
  }
  g.closePath();
  g.fillStyle = LIGHT;
  g.fill();
  g.strokeStyle = LIGHT;
  g.lineWidth = 5;
  g.stroke();
  // Branches: hairline cracks off the seam, lengthening with each hit.
  const reach = stepped(t, 0, [
    [KINK, 90],
    [bf(22), 170],
    [bf(23), 280],
    [bf(23.5), 200],
  ]);
  if (reach > 2) {
    g.strokeStyle = rgba(LIGHT, 0.9);
    g.lineWidth = 4;
    for (let k = 0; k < 9; k++) {
      const x0 = 120 + k * 105 + hash(k, 20) * 40;
      const dir = k % 2 === 0 ? -1 : 1;
      const y0 = crackY(x0, t) + dir * gap * 0.5;
      const len = reach * (0.5 + hash(k, 21));
      const mx = x0 + (hash(k, 22) - 0.5) * len * 0.6;
      const my = y0 + dir * len * 0.5;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(mx, my);
      g.lineTo(mx + (hash(k, 23) - 0.5) * len * 0.5, my + dir * len * 0.5);
      g.stroke();
    }
  }
  drawShards(g, t);
}

/** The crack's hits: on each the seam opens further, throws shards and forces its light further out. */
const HITS = [KINK, bf(22), bf(23)] as const;

/**
 * Light forcing through the crack: a fan of long thin rays up and down from along the seam,
 * reaching further on each hit and holding, faint enough that the frame never flashes.
 */
function drawRays(g: G, t: number): void {
  const reach = stepped(t, 0, [
    [KINK, 420],
    [bf(22), 760],
    [bf(23), 1150],
    [bf(23.5), 900],
  ]);
  if (reach < 4) {
    return;
  }
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 22; k++) {
    const x0 = 40 + (k / 21) * 1000 + (hash(k, 40) - 0.5) * 30;
    const y0 = crackY(x0, t);
    const dir = k % 2 === 0 ? -1 : 1;
    // Each ray leans its own way and breathes on its own rate.
    const lean = (hash(k, 41) - 0.5) * 0.9;
    const len = reach * (0.55 + 0.6 * hash(k, 42)) * (0.92 + 0.08 * Math.sin(t * (0.05 + 0.04 * hash(k, 43)) + k));
    const half = 10 + 26 * hash(k, 44);
    const ex = x0 + Math.sin(lean) * len;
    const ey = y0 + dir * Math.cos(lean) * len;
    const grad = g.createLinearGradient(x0, y0, ex, ey);
    grad.addColorStop(0, rgba(LIGHT, 0.34));
    grad.addColorStop(0.35, rgba(INK.key, 0.12));
    grad.addColorStop(1, rgba(INK.key, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x0 - 4, y0);
    g.lineTo(ex - half * Math.cos(lean), ey - half * Math.sin(lean) * dir);
    g.lineTo(ex + half * Math.cos(lean), ey + half * Math.sin(lean) * dir);
    g.lineTo(x0 + 4, y0);
    g.closePath();
    g.fill();
  }
  g.restore();
}

/**
 * Shards breaking off the crack's lips on each hit: dark slivers edged in white-hot light,
 * flung up and down and toward the lens, tumbling and falling. They are out on the hit's frame.
 */
function drawShards(g: G, t: number): void {
  HITS.forEach((hit, h) => {
    const d = t - hit + 1;
    if (d <= 0 || d > 48) {
      return;
    }
    const s = d / 60;
    const count = 12 + 6 * h;
    for (let i = 0; i < count; i++) {
      const seed = h * 50 + i;
      const x0 = 60 + hash(seed, 50) * 960;
      const dir = hash(seed, 51) < 0.5 ? -1 : 1;
      const vx = (hash(seed, 52) - 0.5) * 900;
      const vy = dir * (500 + 900 * hash(seed, 53));
      const x = x0 + vx * s;
      const y = crackY(x0, t) + vy * s + 1400 * s * s;
      const grow = 1 + 3.2 * s * (0.5 + hash(seed, 54));
      const size = (26 + 44 * hash(seed, 55)) * grow;
      const spin = (hash(seed, 56) - 0.5) * 14 * s;
      const fade = 1 - Math.max(0, (d - 30) / 18);
      g.save();
      g.translate(x, y);
      g.rotate(spin + hash(seed, 57) * Math.PI);
      g.beginPath();
      g.moveTo(-size, -size * 0.25);
      g.lineTo(size * (0.4 + 0.5 * hash(seed, 58)), -size * 0.5);
      g.lineTo(size * 0.7, size * 0.35);
      g.lineTo(-size * 0.3, size * 0.45 * hash(seed, 59) + size * 0.15);
      g.closePath();
      // The shard's face catches the crack's light from the edge it broke off.
      const lit = g.createLinearGradient(-size, 0, size, 0);
      lit.addColorStop(0, rgba('#2a4a60', fade));
      lit.addColorStop(1, rgba(SURV.bg, fade));
      g.fillStyle = lit;
      g.fill();
      g.strokeStyle = rgba(LIGHT, 0.95 * fade);
      g.lineWidth = 4;
      g.stroke();
      g.restore();
    }
  });
}

/**
 * Beats 18-21: extreme close on the watching eye. On 19 the lids snap shut into a white-hot seam
 * across the frame; on 20 the seam kinks into a zig-zag crack that opens and throws off branches.
 */
export function leak(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  const t = Math.round(time);
  const zoom = 1.55 + (time - start) * 0.0006;
  if (t < SHUT + 6) {
    eye(g, ctx, time, SEAM_Y, zoom, false);
    // The lids: two dark shapes that snap together on the seam, most of the way on the hit's own frame.
    const shut = t < SHUT ? 0 : clamp(0.7 + 0.3 * springOf(t + 1, SHUT, SNAPPY), 0, 1);
    const open = 700 * (1 - shut);
    g.fillStyle = SURV.bg;
    g.fillRect(-200, -200, W + 400, SEAM_Y - open + 200);
    g.fillRect(-200, SEAM_Y + open, W + 400, H + 400);
    g.strokeStyle = SURV.line;
    g.lineWidth = 6;
    for (const y of [SEAM_Y - open, SEAM_Y + open]) {
      g.beginPath();
      g.moveTo(-200, y);
      g.lineTo(W + 200, y);
      g.stroke();
    }
    if (t >= SHUT) {
      drawCrack(g, time);
    }
    return [];
  }
  field(g, time, SURV, SEAM_Y, 0.2);
  drawCrack(g, time);
  return [];
}

/** Beats 21-24: the crack in the dark, opening wider on 22 and 23, drawing in on the silence at 23.5; on 24 it bursts. */
export function worldToSee(g: G, time: number): void {
  field(g, time, SURV, SEAM_Y, 0.15);
  drawCrack(g, time);
}
