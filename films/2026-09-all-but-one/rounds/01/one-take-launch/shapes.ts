import { clamp, lerp } from './motion.js';
import { AI_BLUE, AI_BLUE_DEEP, AI_GLINT, DEMON, EMBER, TOOTH } from './palette.js';

type P = CanvasRenderingContext2D;

/** Mixes two `#rrggbb` colours. */
export function mix(a: string, b: string, u: number): string {
  const k = clamp(u);
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number): number =>
    Math.round(lerp((pa >> shift) & 255, (pb >> shift) & 255, k));
  return `rgb(${String(ch(16))},${String(ch(8))},${String(ch(0))})`;
}

/**
 * A speech bubble's outline as `n` points around it, centred at 0,0, starting at
 * the top-left corner, the tail at the bottom left. Sampled evenly by parameter,
 * so two outlines with the same `n` morph point for point.
 */
export function bubblePoints(w: number, h: number, n: number, tail = 1): [number, number][] {
  const r = Math.min(w, h) * 0.32;
  const pts: [number, number][] = [];
  const hw = w / 2;
  const hh = h / 2;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    // walk a rounded rectangle by angle from its centre, squared off at the corners
    const a = -Math.PI * 0.75 + u * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const px = Math.sign(c) * Math.abs(c) ** 0.28 * hw;
    const py = Math.sign(s) * Math.abs(s) ** 0.28 * hh;
    const k = Math.max(Math.abs(px) / hw, Math.abs(py) / hh);
    let x = px / k;
    let y = py / k;
    const cx = Math.max(Math.abs(x) - (hw - r), 0);
    const cy = Math.max(Math.abs(y) - (hh - r), 0);
    if (cx > 0 && cy > 0) {
      const d = Math.hypot(cx, cy) || 1;
      x = Math.sign(x) * (hw - r + (cx / d) * r);
      y = Math.sign(y) * (hh - r + (cy / d) * r);
    }
    // the tail: bottom edge near the left, pulled down to a point
    const along = (x + hw) / w;
    if (y > hh * 0.98 && along > 0.12 && along < 0.38) {
      const v = 1 - Math.abs((along - 0.2) / 0.18);
      y += Math.max(0, v) ** 1.5 * h * 0.34 * tail;
      x -= Math.max(0, v) * w * 0.05 * tail;
    }
    pts.push([x, y]);
  }
  return pts;
}

export function polygon(g: P, pts: readonly [number, number][]): void {
  g.beginPath();
  g.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) {
    g.lineTo(pts[i]![0], pts[i]![1]);
  }
  g.closePath();
}

/** A rounded rectangle path. */
export function rrect(g: P, x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + k, y);
  g.arcTo(x + w, y, x + w, y + h, k);
  g.arcTo(x + w, y + h, x, y + h, k);
  g.arcTo(x, y + h, x, y, k);
  g.arcTo(x, y, x + w, y, k);
  g.closePath();
}

/** An AI card: a blue speech bubble, with `typed` of its three lines of text-bars written. */
export function aiBubble(
  g: P,
  { w, h, typed, fill = AI_BLUE, tail = 1 }: { w: number; h: number; typed: number; fill?: string; tail?: number }
): void {
  polygon(g, bubblePoints(w, h, 48, tail));
  g.fillStyle = AI_BLUE_DEEP;
  g.save();
  g.translate(0, h * 0.05);
  g.fill();
  g.restore();
  polygon(g, bubblePoints(w, h, 48, tail));
  g.fillStyle = fill;
  g.fill();
  if (typed > 0) {
    const lines = [0.78, 0.92, 0.55];
    g.fillStyle = AI_GLINT;
    for (let i = 0; i < 3; i++) {
      const u = clamp(typed * 3 - i);
      if (u <= 0) {
        continue;
      }
      const lw = (w * 0.8 - 20) * lines[i]! * u;
      rrect(g, -w * 0.4 + 10, -h * 0.3 + i * h * 0.22, lw, h * 0.1, h * 0.05);
      g.fill();
    }
  }
}

/** How one demon is built, so no two in a flock are the same creature. */
export interface DemonDesign {
  /** Horn length and curl: curl bends the tips in (negative) or out (positive). */
  horn: number;
  curl: number;
  /** Wing span, and how many scallops its trailing edge has. */
  wing: number;
  scallops: number;
  /** 0: two slit eyes; 1: one big eye; 2: three small eyes. */
  eyes: number;
  /** Teeth in the grin. */
  teeth: number;
  /** A tail's length, 0 for none. */
  tail: number;
}

export const PLAIN_DEMON: DemonDesign = { horn: 1, curl: 0, wing: 1, scallops: 3, eyes: 0, teeth: 6, tail: 0 };

/** A bat wing on `side`, beating at angle `flap`, in units of the body's height. */
function wing(g: P, side: number, flap: number, s: number, scallops: number): void {
  g.save();
  g.scale(side, 1);
  g.rotate(-flap);
  g.beginPath();
  g.moveTo(0, -0.1 * s);
  g.lineTo(0.55 * s, -0.55 * s);
  g.lineTo(1.05 * s, -0.25 * s);
  for (let i = 0; i < scallops; i++) {
    const x0 = 1.05 - (i / scallops) * 1.05;
    const x1 = 1.05 - ((i + 1) / scallops) * 1.05;
    g.quadraticCurveTo(((x0 + x1) / 2) * s, (-0.12 + 0.1 * (i / scallops)) * s, x1 * s, (0.02 + 0.13 * ((i + 1) / scallops)) * s);
  }
  g.closePath();
  g.fill();
  g.restore();
}

/**
 * A secret turned demon: a speech bubble `w` by `h` that has grown horns, wings,
 * ember eyes and teeth as `m` runs 0 to 1, its colour running from AI blue to ink.
 * `flapR` beats the right wing apart from the left.
 */
export function demon(
  g: P,
  {
    w,
    h,
    m,
    flap,
    flapR = flap * 0.86 + 0.08,
    grin = 1,
    look = 0,
    design = PLAIN_DEMON,
  }: { w: number; h: number; m: number; flap: number; flapR?: number; grin?: number; look?: number; design?: DemonDesign }
): void {
  const body = mix(AI_BLUE, DEMON, m);
  g.fillStyle = body;
  g.strokeStyle = body;
  if (m > 0.02) {
    const s = h * 1.15 * design.wing * clamp(m * 1.4);
    g.save();
    g.translate(w * 0.38, -h * 0.05);
    wing(g, 1, flapR, s, design.scallops);
    g.restore();
    g.save();
    g.translate(-w * 0.38, -h * 0.05);
    wing(g, -1, flap, s, design.scallops);
    g.restore();
    // horns
    const hl = h * 0.42 * design.horn * clamp(m * 1.6 - 0.2);
    for (const side of [-1, 1]) {
      const bx = side * w * 0.28;
      const tip = side * h * (0.14 + 0.2 * design.curl);
      g.beginPath();
      g.moveTo(bx - h * 0.11, -h * 0.42);
      g.quadraticCurveTo(bx + side * h * 0.02, -h * 0.5 - hl * 0.6, bx + tip, -h * 0.46 - hl);
      g.quadraticCurveTo(bx + side * h * 0.04, -h * 0.5 - hl * 0.2, bx + h * 0.11, -h * 0.42);
      g.closePath();
      g.fill();
    }
    if (design.tail > 0) {
      g.lineWidth = h * 0.07;
      g.lineCap = 'round';
      const tl = h * design.tail * clamp(m * 1.5 - 0.3);
      const sway = Math.sin(flap * 2) * 0.3;
      g.beginPath();
      g.moveTo(w * 0.2, h * 0.4);
      g.quadraticCurveTo(w * 0.4 + tl * 0.4, h * 0.5 + tl * (0.6 + sway), w * 0.3 + tl * 0.8, h * 0.3 + tl * 0.5);
      g.stroke();
      g.beginPath();
      g.moveTo(w * 0.3 + tl * 0.8, h * 0.3 + tl * 0.5 - h * 0.12);
      g.lineTo(w * 0.3 + tl * 0.8 + h * 0.12, h * 0.3 + tl * 0.5 + h * 0.04);
      g.lineTo(w * 0.3 + tl * 0.8 - h * 0.08, h * 0.3 + tl * 0.5 + h * 0.08);
      g.closePath();
      g.fill();
    }
  }
  polygon(g, bubblePoints(w, h, 40, 1));
  g.fill();
  if (m > 0.3) {
    const e = clamp((m - 0.3) / 0.5);
    g.fillStyle = EMBER;
    if (design.eyes === 1) {
      g.beginPath();
      g.ellipse(look * w * 0.05, -h * 0.13, h * 0.17 * e, h * 0.11 * e, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = DEMON;
      g.beginPath();
      g.ellipse(look * w * 0.09, -h * 0.13, h * 0.035 * e, h * 0.09 * e, 0, 0, Math.PI * 2);
      g.fill();
    } else {
      const spots = design.eyes === 2 ? [-1, 0, 1] : [-1, 1];
      for (const side of spots) {
        g.save();
        g.translate(side * w * (design.eyes === 2 ? 0.14 : 0.18) + look * w * 0.04, -h * (side === 0 ? 0.24 : 0.12));
        g.rotate(side * 0.35);
        g.beginPath();
        const k = design.eyes === 2 ? 0.7 : 1;
        g.ellipse(0, 0, h * 0.13 * e * k, h * 0.06 * e * k, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    }
    // teeth
    const tw = w * 0.5 * e * Math.min(grin, 1.6);
    if (tw > 1) {
      g.fillStyle = TOOTH;
      const n = Math.max(2, Math.round(design.teeth)) * 2 - 2;
      const bite = h * 0.12 * Math.max(1, grin);
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const x = -tw / 2 + (tw * i) / n;
        const y = h * 0.14 + (i % 2 === 0 ? 0 : bite) - Math.abs(x / tw) * h * 0.08;
        if (i === 0) {
          g.moveTo(x, y);
        } else {
          g.lineTo(x, y);
        }
      }
      g.lineTo(tw / 2, h * 0.1 - h * 0.04);
      g.lineTo(-tw / 2, h * 0.1 - h * 0.04);
      g.closePath();
      g.fill();
    }
  }
}

/**
 * The HushBox mark, in units of its size: a centre dot and eight arcs in four
 * sweeping pairs. `a` gives each arc's assembly 0..1 (it swings in from `spread`
 * radians behind its place and grows its sweep); `spin` turns the whole mark.
 */
export function mark(
  g: P,
  {
    size,
    spin,
    a,
    dot,
    color,
    spread = 1,
  }: { size: number; spin: number; a: readonly number[]; dot: number; color: string; spread?: number }
): void {
  g.save();
  g.rotate(spin);
  g.strokeStyle = color;
  g.lineCap = 'round';
  for (let k = 0; k < 4; k++) {
    const base = k * (Math.PI / 2);
    for (const [inner, index] of [
      [false, k * 2],
      [true, k * 2 + 1],
    ] as const) {
      const u = clamp(a[index] ?? 1);
      if (u <= 0.001) {
        continue;
      }
      const r0 = inner ? 0.2 : 0.33;
      const r1 = inner ? 0.3 : 0.45;
      const sweep = (inner ? 1.25 : 1.35) * u;
      const start = base + (inner ? Math.PI * 0.62 : 0) - (1 - u) * 1.2;
      g.lineWidth = size * 0.085 * (0.4 + 0.6 * u);
      g.beginPath();
      const n = 20;
      for (let i = 0; i <= n; i++) {
        const v = i / n;
        const ang = start + sweep * v;
        const rad = size * lerp(r0, r1, v) * (0.6 + 0.4 * u) * spread;
        const x = Math.cos(ang) * rad;
        const y = Math.sin(ang) * rad;
        if (i === 0) {
          g.moveTo(x, y);
        } else {
          g.lineTo(x, y);
        }
      }
      g.stroke();
    }
  }
  if (dot > 0) {
    g.beginPath();
    g.arc(0, 0, size * 0.082 * dot, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
  }
  g.restore();
}
