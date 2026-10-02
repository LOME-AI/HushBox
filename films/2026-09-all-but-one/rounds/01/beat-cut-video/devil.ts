import { TAU, boil, clamp, hash, lerp, polyline, rgba } from './kit.js';

import type { G } from './kit.js';

type P = [number, number];

export interface DevilPose {
  x: number;
  y: number;
  /** Pixels per head unit; the head spans about 2.2 units wide with horns, 3 tall. */
  scale: number;
  /** How much of the drawing has drawn on, 0 to 1, part after part. */
  draw: number;
  /** 1 delight (grin, V brows, slit eyes) through 0 to -1 terror (O mouth, raised brows, pinned eyes). */
  mood: number;
  /** How far the jaw is open, 0 to 1; the chin drops with it. */
  jaw: number;
  /** How much the whole drawing shakes, in head units. */
  tremble: number;
  /** Horn length, 0 to 1. */
  horns: number;
  line: string;
  eye: string;
  /** The face's fill, which hides whatever is behind the head; null leaves it open. */
  fill: string | null;
  lineWidth: number;
  /** Where the pupils look, -1 (his right, screen left) to 1 (screen right). */
  look?: number;
  /** Head tilt in radians. */
  tilt?: number;
  /** 0 to 1: the drawing tears into its strokes, each a rigid piece spiralling into (pullX, pullY). */
  shatter?: number;
  pullX?: number;
  pullY?: number;
}

function quad(a: P, c: P, b: P, n: number): P[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const s = i / n;
    const u = 1 - s;
    return [u * u * a[0] + 2 * u * s * c[0] + s * s * b[0], u * u * a[1] + 2 * u * s * c[1] + s * s * b[1]];
  });
}

/** The head's outline; below the cheekbones it stretches down as the jaw opens. */
function headOutline(jaw: number): P[] {
  const pts: P[] = [];
  for (let i = 0; i < 72; i++) {
    const th = (i / 72) * TAU;
    let y = -0.95 * Math.cos(th);
    let x = 0.8 * Math.sin(th);
    if (y > 0) {
      const k = y / 0.95;
      x *= 1 - 0.55 * k ** 1.6;
      y += 0.22 * k ** 3;
      y *= 1 + 0.2 * jaw * k;
    }
    x *= 1 + 0.09 * Math.exp(-(((y - 0.05) / 0.28) ** 2));
    pts.push([x, y]);
  }
  return pts;
}

function horn(side: number, length: number): P[] {
  const base: P = [side * 0.36, -0.8];
  const ctrl: P = [side * 1.05, -1.0];
  // The two horns are not twins: his left curls higher and further.
  const tip: P = [side * (side < 0 ? 0.74 : 0.66), side < 0 ? -1.96 : -1.82];
  const n = 18;
  const centre = quad(base, ctrl, tip, n).slice(0, Math.max(2, Math.round(n * clamp(length)) + 1));
  const left: P[] = [];
  const right: P[] = [];
  const m = centre.length;
  for (let i = 0; i < m; i++) {
    const a = centre[Math.max(0, i - 1)] as P;
    const b = centre[Math.min(m - 1, i + 1)] as P;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const w = 0.15 * (1 - i / (n + 1));
    const c = centre[i] as P;
    left.push([c[0] - (dy / len) * w, c[1] + (dx / len) * w]);
    right.push([c[0] + (dy / len) * w, c[1] - (dx / len) * w]);
  }
  return [...left, ...right.reverse()];
}

/** How open each eyelid is at `time`: each eye blinks on its own clock, the right one late and shallow. */
function lids(time: number, fear: number): [number, number] {
  const period = lerp(104, 58, fear);
  const one = (lag: number, depth: number): number => {
    const b = ((time + lag) / period) % 1;
    return b < 0.07 ? 1 - depth * Math.sin((Math.PI * b) / 0.07) : 1;
  };
  return [one(0, 1), one(-3, 0.75)];
}

interface Part {
  pts: P[];
  closed: boolean;
  eye?: -1 | 1;
}

/** The parts of the face at a mood and jaw, in draw-on order, each an open or closed polyline. */
function parts(mood: number, jaw: number, horns: number, open: [number, number]): Part[] {
  const m = (mood + 1) / 2;
  const fear = clamp(-mood);
  const out: Part[] = [];
  if (horns > 0) {
    out.push({ pts: horn(-1, horns), closed: true }, { pts: horn(1, horns), closed: true });
  }
  const chin = 0.2 * jaw;
  out.push({ pts: headOutline(jaw), closed: true });
  for (const s of [-1, 1] as const) {
    const lead = s < 0;
    out.push({ pts: [[s * 0.77, -0.28], [s * 1.18, -0.62], [s * 0.8, 0.02]], closed: false });
    // Brows: a V of menace when delighted (his left arched higher), raised at the middle in
    // terror (his right higher, the brow that gives way first).
    const arch = lead ? 0.05 * m : 0.05 * fear;
    const inner: P = [s * 0.1, lerp(-0.6, -0.3, m) - arch];
    const outer: P = [s * 0.58, lerp(-0.4, -0.54, m) - arch * 1.4];
    out.push({ pts: quad(inner, [s * 0.34, lerp(-0.62, -0.36, m) - arch * 1.6], outer, 6), closed: false });
    // Eyes: slanted almonds when delighted, wide rings in terror; his left the larger.
    const size = lead ? 1.07 : 0.93;
    const ex = s * 0.3;
    const ey = -0.2;
    const hw = lerp(0.14, 0.18, m) * size;
    const hh = lerp(0.14, 0.05, m) * size * (lead ? open[0] : open[1]);
    const slant = lerp(0, 0.05, m) * (lead ? 1.2 : 0.8);
    const eye: P[] = [];
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * TAU;
      const px = Math.cos(a) * hw;
      eye.push([ex + px, ey + Math.sin(a) * Math.max(0.004, hh) * (1 - 0.3 * Math.abs(Math.cos(a))) + (s * px * slant) / hw]);
    }
    out.push({ pts: eye, closed: true, eye: s });
  }
  out.push({ pts: [[0.02, -0.08], [0.08, 0.14], [-0.03, 0.17]], closed: false });
  out.push({ pts: [[-0.52, -0.7], [0, -0.48], [0.52, -0.7]], closed: false });
  if (m > 0.5) {
    const g = (m - 0.5) * 2;
    const drop = 0.5 + 0.28 * jaw;
    // The grin is lopsided: his left corner hitched higher.
    const left: P = [-0.62, 0.17 - 0.1 * g];
    const right: P = [0.58, 0.22 - 0.04 * g];
    const smile = quad(left, [0.03, lerp(0.35, drop + 0.25, g) + chin], right, 16);
    const lip = quad(left, [0.02, 0.34], right, 12);
    out.push({ pts: smile, closed: false }, { pts: lip, closed: false });
    for (let i = 1; i < 9; i++) {
      const s = i / 9;
      const a = lip[Math.round(s * 12)] as P;
      const b = smile[Math.round(s * 16)] as P;
      out.push({ pts: [a, [lerp(a[0], b[0], 0.5) + 0.015, lerp(a[1], b[1], 0.55)], [a[0] + 0.05, a[1] + 0.005]], closed: false });
    }
  } else {
    // Terror: a mouth hanging below the nose, never reaching it, pulled to one side.
    const f = 1 - m * 2;
    const rx = 0.11 + 0.1 * jaw + 0.03 * f;
    const ry = 0.07 + 0.2 * jaw + 0.04 * f;
    const cy = 0.5 + 0.12 * jaw;
    const mouth: P[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU;
      const skew = 0.04 * Math.sin(a) * f;
      mouth.push([0.02 + Math.cos(a) * rx + skew, cy + Math.sin(a) * ry]);
    }
    out.push({ pts: mouth, closed: true });
    out.push({ pts: [[-0.5, 0.18], [-0.36, 0.34], [-0.41, 0.56 + chin]], closed: false });
    out.push({ pts: [[0.5, 0.2], [0.38, 0.38], [0.4, 0.58 + chin]], closed: false });
  }
  const gy = 1.02 * (1 + chin);
  out.push({ pts: [[-0.16, gy], [-0.1, gy + 0.28], [0, gy + 0.5], [0.1, gy + 0.28], [0.16, gy]], closed: false });
  for (let i = 0; i < 6; i++) {
    const y = 0.02 + i * 0.07;
    out.push({ pts: [[-0.66 + i * 0.02, y], [-0.5 + i * 0.03, y + 0.1]], closed: false });
  }
  return out;
}

/**
 * The Devil as an engraved line drawing: horns, face, ears, brows, eyes, grin
 * or scream, goatee and hatching, every stroke boiling a few times a second and
 * drawn on part after part. His eyes blink apart and differ in size.
 */
export function drawDevil(g: G, time: number, pose: DevilPose): void {
  const fear = clamp(-pose.mood);
  const open = lids(time, fear);
  const list = parts(pose.mood, pose.jaw, pose.horns, open);
  const total = list.length;
  const reach = clamp(pose.draw) * total;
  const shatter = pose.shatter ?? 0;
  const t = time / 60;
  const trembleX = pose.tremble * Math.sin(t * 61) * Math.sin(t * 13.7);
  const trembleY = pose.tremble * Math.sin(t * 47 + 1) * Math.sin(t * 9.1);
  const tilt = pose.tilt ?? 0;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const place = (p: P, i: number, pi: number): P => {
    const jx = boil(time, pi * 97 + i, 9) * 0.008;
    const jy = boil(time, pi * 89 + i + 7, 9) * 0.008;
    const x = p[0] + jx + trembleX;
    const y = p[1] + jy + trembleY;
    return [pose.x + (x * cos - y * sin) * pose.scale, pose.y + (x * sin + y * cos) * pose.scale];
  };
  const px = pose.pullX ?? pose.x;
  const py = pose.pullY ?? pose.y;
  /** A part torn loose: its whole stroke moves as one piece, turning and shrinking into the pull. */
  const tear = (pts: P[], pi: number): P[] => {
    if (shatter <= 0) {
      return pts;
    }
    const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length;
    const cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
    const order = hash(pi, 91);
    const k = clamp((shatter - order * 0.45) / 0.55);
    const e = k * k * (3 - 2 * k);
    const a = e * (1.6 + 1.2 * hash(pi, 92));
    const r = 1 - e;
    const dx = cx - px;
    const dy = cy - py;
    const nx = px + (dx * Math.cos(a) - dy * Math.sin(a)) * r;
    const ny = py + (dx * Math.sin(a) + dy * Math.cos(a)) * r;
    const spin = e * (hash(pi, 93) - 0.5) * 3;
    const sc = 1 - 0.8 * e;
    return pts.map(([x, y]) => {
      const qx = (x - cx) * sc;
      const qy = (y - cy) * sc;
      return [nx + qx * Math.cos(spin) - qy * Math.sin(spin), ny + qx * Math.sin(spin) + qy * Math.cos(spin)];
    });
  };
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const outlineIndex = pose.horns > 0 ? 2 : 0;
  const outlinePart = list[outlineIndex];
  if (pose.fill !== null && reach >= outlineIndex + 1 && outlinePart !== undefined && shatter < 0.05) {
    const outline = outlinePart.pts.map((p, i) => place(p, i, outlineIndex));
    g.fillStyle = pose.fill;
    g.beginPath();
    outline.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
    g.fill();
  }
  const m = (pose.mood + 1) / 2;
  for (let pi = 0; pi < total; pi++) {
    const p = clamp(reach - pi);
    if (p <= 0) {
      break;
    }
    const part = list[pi];
    if (part === undefined) {
      continue;
    }
    const pts = tear(
      part.pts.map((q, i) => place(q, i, pi)),
      pi
    );
    g.strokeStyle = rgba(pose.line, 0.25);
    g.lineWidth = pose.lineWidth * 3.2;
    polyline(g, pts, p, part.closed);
    g.strokeStyle = pose.line;
    g.lineWidth = pose.lineWidth;
    polyline(g, pts, p, part.closed);
    if (part.eye !== undefined && p >= 1) {
      const lead = part.eye < 0;
      const lid = lead ? open[0] : open[1];
      if (lid < 0.25) {
        continue;
      }
      const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length;
      const cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
      // Terror pins the pupils small; one darts a beat behind the other.
      const dart = fear > 0.2 ? Math.sin(t * (lead ? 23 : 17) + (lead ? 0 : 1.3)) * 0.03 * fear : 0;
      const look = ((pose.look ?? 0) * 0.07 + dart) * pose.scale * (lead ? 1 : 0.85);
      const size = (lead ? 1.1 : 0.85) * pose.scale;
      g.fillStyle = pose.eye;
      g.beginPath();
      g.ellipse(cx + look, cy, size * lerp(0.03, 0.03, m), size * lerp(0.03, 0.07, m) * lid, 0, 0, TAU);
      g.fill();
    }
  }
  g.restore();
}
