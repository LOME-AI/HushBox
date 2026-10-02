import { TAU, clamp, hash, lerp } from './kit.js';

import type { G } from './kit.js';

export interface Flame {
  x: number;
  y: number;
  /** Height of the column in px. */
  height: number;
  /** Width of its base in px. */
  width: number;
  /** 0 a single tongue; 1 split into two horn-shaped plumes that curl out and up. */
  split: number;
  /** Brightness, 0 to 1. */
  heat: number;
  particles?: number;
  seed?: number;
}

/**
 * An additive particle flame, each tongue a closed-form loop of its seed: it is
 * born at the base, rises, curls and fades, so any frame draws alone.
 */
export function drawFlame(g: G, time: number, f: Flame): void {
  const t = time / 60;
  const n = f.particles ?? 170;
  const seed = f.seed ?? 11;
  g.save();
  g.globalCompositeOperation = 'lighter';
  const glow = g.createRadialGradient(f.x, f.y - f.height * 0.2, 0, f.x, f.y - f.height * 0.2, f.height * 0.9);
  glow.addColorStop(0, `rgba(255,150,50,${String(0.28 * f.heat)})`);
  glow.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = glow;
  g.fillRect(f.x - f.height, f.y - f.height * 1.3, f.height * 2, f.height * 1.6);
  for (let i = 0; i < n; i++) {
    const h1 = hash(i, seed);
    const h2 = hash(i + 1000, seed);
    const h3 = hash(i + 2000, seed);
    const h4 = hash(i + 3000, seed);
    const rate = 0.9 + 0.9 * h1;
    const life = (t * rate + h2) % 1;
    const side = i % 2 === 0 ? -1 : 1;
    const rise = life * f.height * (0.75 + 0.45 * h3);
    const sway = Math.sin(life * 6 + t * 4.3 + h4 * TAU) * f.width * 0.28 * (1 - life * 0.5);
    // Split: each tongue leans to its side and curls up and in, a horn's centreline.
    // The two arms are not twins: the left leads the split, leans wider and curls higher;
    // the right follows late, rises straighter and hooks in sooner.
    const s = side < 0 ? f.split : Math.max(0, f.split * 1.3 - 0.3);
    const hornX =
      side < 0
        ? -f.width * (0.3 + 1.8 * life - 1.2 * life * life) * s
        : f.width * (0.18 + 1.25 * life - 1.05 * life * life) * s;
    const x = f.x + lerp(sway * (1 - life), sway * 0.3, s) + hornX + (h1 - 0.5) * f.width * 0.5 * (1 - s);
    const y = f.y - rise * lerp(1, side < 0 ? 1.22 : 1.05, s);
    const r = f.width * 0.34 * (1 - life) ** 0.8 * (0.55 + 0.9 * h3) * lerp(1, 0.7, s);
    const a = (1 - life) * f.heat * (0.35 + 0.4 * h4);
    const hot = clamp(1 - life * 2.2);
    const cr = 255;
    const cg = Math.round(lerp(90, 235, hot));
    const cb = Math.round(lerp(20, 170, hot * hot));
    g.fillStyle = `rgba(${String(cr)},${String(cg)},${String(cb)},${String(a)})`;
    g.beginPath();
    g.arc(x, y, Math.max(0.5, r), 0, TAU);
    g.fill();
  }
  // Sparks: fast, thin, drifting off the top.
  for (let i = 0; i < 40; i++) {
    const h1 = hash(i + 5000, seed);
    const h2 = hash(i + 6000, seed);
    const life = (t * (0.6 + h1) + h2) % 1;
    const x = f.x + (h1 - 0.5) * f.width * 1.6 + Math.sin(life * 9 + h2 * 20) * 26 * life;
    const y = f.y - f.height * (0.3 + 1.2 * life);
    g.fillStyle = `rgba(255,${String(Math.round(180 + 60 * h2))},120,${String((1 - life) * f.heat * 0.9)})`;
    g.fillRect(x, y, 3, 3 + 8 * (1 - life));
  }
  g.restore();
}

/** A small hot point: the ember the frame inhales to. */
export function drawEmber(g: G, time: number, x: number, y: number, r: number, heat: number): void {
  g.save();
  g.globalCompositeOperation = 'lighter';
  const flicker = 0.85 + 0.15 * Math.sin(time * 0.9) * Math.sin(time * 0.37);
  const grad = g.createRadialGradient(x, y, 0, x, y, r * 4);
  grad.addColorStop(0, `rgba(255,240,200,${String(heat * flicker)})`);
  grad.addColorStop(0.25, `rgba(255,140,40,${String(heat * 0.6 * flicker)})`);
  grad.addColorStop(1, 'rgba(255,60,10,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, r * 4, 0, TAU);
  g.fill();
  g.restore();
}
