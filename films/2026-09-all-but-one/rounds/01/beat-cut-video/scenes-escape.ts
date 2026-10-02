import { drawDevil } from './devil.js';
import { drawFlame } from './fire.js';
import {
  CX,
  DEFAULT,
  FPB,
  H,
  HELL,
  INK,
  NIGHT,
  TAU,
  W,
  bf,
  beatPulse,
  clamp,
  env,
  hash,
  hs,
  lerp,
  outExpo,
  PLAYFUL,
  prog,
  rgba,
  smooth,
  SNAPPY,
  springOf,
  wander,
} from './kit.js';
import { field } from './scenes-praise.js';
import { SWOOP_BEATS } from './score.js';
import { fontOf, imagery } from './type.js';

import type { G, Palette } from './kit.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

const HEAD: readonly (readonly [number, number])[] = [
  [-0.5, -0.1],
  [-0.62, -0.5],
  [-0.9, -1.05],
  [-0.34, -0.5],
  [0, -0.58],
  [0.34, -0.5],
  [0.9, -1.05],
  [0.62, -0.5],
  [0.5, -0.1],
  [0.48, 0.3],
  [0.22, 0.62],
  [0, 0.72],
  [-0.22, 0.62],
  [-0.48, 0.3],
];

/**
 * A demon: a horned skull of shadow with burning slit eyes and a jagged mouth,
 * trailing a tail of embers along the path it came by. `past(k)` gives where
 * it was `k` frames ago; the tail is those points.
 */
export function demon(
  g: G,
  time: number,
  d: {
    x: number;
    y: number;
    size: number;
    angle: number;
    jaw: number;
    seed: number;
    pal: Palette;
    past: (k: number) => [number, number];
    /** Each eye's height, left then right; by default seeded apart and blinking apart. */
    eyes?: readonly [number, number];
    /** How tall the head is drawn against its width. */
    stretch?: number;
  }
): void {
  const { pal } = d;
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (let k = 14; k >= 1; k--) {
    const [px, py] = d.past(k * 2);
    const r = d.size * 0.42 * (1 - k / 16) * (0.8 + 0.4 * hash(k + d.seed * 31 + Math.floor(time / 4), 9));
    g.fillStyle = rgba(k < 5 ? pal.key : pal.line, 0.5 * (1 - k / 15));
    g.beginPath();
    g.arc(px + hs(k * 7 + d.seed, 3) * 8, py + hs(k * 11 + d.seed, 3) * 8, r, 0, TAU);
    g.fill();
  }
  g.restore();
  g.save();
  g.translate(d.x, d.y);
  g.rotate(d.angle);
  const s = d.size;
  const stretch = (d.stretch ?? 1) * (1 + 0.25 * d.jaw);
  const blinkOf = (lag: number): number => {
    const b = ((time + lag + hash(d.seed, 7) * 90) / (70 + 40 * hash(d.seed, 8))) % 1;
    return b < 0.08 ? 0.15 : 1;
  };
  const eyes = d.eyes ?? [(0.7 + 0.7 * hash(d.seed, 5)) * blinkOf(0), (0.7 + 0.7 * hash(d.seed, 6)) * blinkOf(4)];
  g.scale(s / stretch ** 0.5, s * stretch);
  g.beginPath();
  HEAD.forEach(([x, y], i) => {
    const jx = hs(i + Math.floor(time / 5) * 17 + d.seed * 101, 4) * 0.03;
    const yy = y > 0.2 ? y + d.jaw * 0.3 : y;
    if (i === 0) {
      g.moveTo(x + jx, yy);
    } else {
      g.lineTo(x + jx, yy);
    }
  });
  g.closePath();
  g.fillStyle = '#140402';
  g.fill();
  g.lineWidth = 0.05;
  g.strokeStyle = pal.line;
  g.stroke();
  g.fillStyle = pal.key;
  for (const side of [-1, 1]) {
    const h = (side < 0 ? eyes[0] : eyes[1]) * 0.09;
    g.beginPath();
    g.moveTo(side * 0.08, -0.08);
    g.lineTo(side * 0.36, -0.11 - h);
    g.lineTo(side * 0.3, -0.11 + h * 0.9);
    g.closePath();
    g.fill();
  }
  g.beginPath();
  g.moveTo(-0.3, 0.3);
  for (let i = 0; i <= 8; i++) {
    g.lineTo(-0.3 + i * 0.075, 0.3 + (i % 2 === 0 ? 0 : 0.08) + d.jaw * 0.12 * Math.sin((i / 8) * Math.PI));
  }
  for (let i = 8; i >= 0; i--) {
    g.lineTo(-0.3 + i * 0.075, 0.3 + d.jaw * 0.32 * Math.sin((i / 8) * Math.PI) + 0.02);
  }
  g.closePath();
  g.fillStyle = pal.hot;
  g.fill();
  g.restore();
}

/** Where escaping demon `i` is `u` seconds after the drop: out of the centre, clawing up and outward. */
function escapeAt(i: number, u: number, cx: number, cy: number): [number, number] {
  const a = -Math.PI / 2 + hs(i, 21) * 1.35;
  const speed = 420 + 380 * hash(i, 22);
  const r = speed * u * (1 + 0.6 * u);
  const swirl = Math.sin(u * (3 + 2 * hash(i, 23)) + i) * 90 * u;
  return [cx + Math.cos(a) * r + Math.cos(a + Math.PI / 2) * swirl, cy + Math.sin(a) * r * 0.9 + Math.sin(a + Math.PI / 2) * swirl];
}

/** Rising smoke: large soft blobs on closed-form loops. */
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

/** Beat 24-28: the ember detonates; shock ring, speed lines, and demons clawing out. */
export function escape(g: G, time: number): void {
  const drop = bf(24);
  const u = (time - drop) / 60;
  field(g, time, HELL, 1500, 0.8);
  smoke(g, time, '#5a1406', 0.6);
  const cx = CX;
  const cy = 1150;
  const ring = outExpo(u / 0.8) * 1500;
  g.save();
  g.strokeStyle = rgba(HELL.hot, clamp(1 - u * 1.2));
  g.lineWidth = 30 * clamp(1 - u);
  g.beginPath();
  g.arc(cx, cy, ring, 0, TAU);
  g.stroke();
  g.globalCompositeOperation = 'lighter';
  const lines = 110;
  for (let i = 0; i < lines; i++) {
    const a = hash(i, 51) * TAU;
    const r0 = 80 + ring * 0.25 * hash(i, 52) + 900 * u;
    const len = (160 + 520 * hash(i, 53)) * clamp(1.4 - u);
    g.strokeStyle = rgba(i % 3 === 0 ? HELL.key : HELL.line, 0.5 * clamp(1.2 - u));
    g.lineWidth = 2 + 3 * hash(i, 54);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
    g.stroke();
  }
  g.restore();
  drawFlame(g, time, { x: cx, y: cy + 160, height: 420 * clamp(1.2 - u * 0.3), width: 200, split: 0, heat: 1, particles: 140, seed: 23 });
  for (let i = 0; i < 16; i++) {
    const born = drop + i * 3 + 6 * hash(i, 24);
    const du = (time - born) / 60;
    if (du <= 0) {
      continue;
    }
    const [x, y] = escapeAt(i, du, cx, cy);
    const [px, py] = escapeAt(i, du - 0.03, cx, cy);
    demon(g, time, {
      x,
      y,
      size: (70 + 70 * hash(i, 25)) * (0.4 + clamp(du * 2)),
      angle: Math.atan2(y - py, x - px) + Math.PI / 2,
      jaw: 0.5 + 0.5 * Math.sin(time * 0.4 + i),
      seed: i,
      pal: HELL,
      past: (k) => escapeAt(i, Math.max(0, du - k / 60), cx, cy),
    });
  }
}

/** A window on a street wall, in world units: side, depth, height. */
interface Win {
  side: number;
  z: number;
  y: number;
}

/** Where swooping demon `k` is in the world at time `time` (frames): it passes the lens on its beat. */
function swoopAt(k: number, time: number): [number, number, number] {
  const pass = bf(SWOOP_BEATS[k] ?? 30);
  const s = (time - pass) / 60;
  const side = k % 2 === 0 ? -1 : 1;
  return [side * (0.12 - 0.5 * s) + 0.08 * Math.sin(s * 5 + k), -0.1 + 0.6 * s, 0.35 - 9 * s];
}

/**
 * Beat 28-32: the camera flies down a line-drawn street that builds itself
 * ahead of it; demons swoop down the street and past the lens, and every
 * window a demon passes lights up.
 */
export function world(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  const pal = NIGHT;
  const t = time - start;
  field(g, time, pal, 900, 0.2);
  const vx = CX;
  const vy = 980;
  const f = 700;
  const cam = t * 0.09;
  // Stars.
  for (let i = 0; i < 120; i++) {
    const x = hash(i, 81) * W;
    const y = hash(i, 82) * 900;
    g.fillStyle = rgba(pal.hot, 0.2 + 0.5 * hash(i + Math.floor(time / 9), 83));
    g.fillRect(x, y, 2, 2);
  }
  const project = (x: number, y: number, z: number): [number, number] => [vx + (x / z) * f, vy + (y / z) * f];
  // Ground: a checkerboard in one-point perspective.
  g.strokeStyle = rgba(pal.line, 0.4);
  g.lineWidth = 1.5;
  for (let i = -8; i <= 8; i++) {
    const [ax, ay] = project(i * 0.5, 1, 0.3);
    const [bx, by] = project(i * 0.5, 1, 40);
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.stroke();
  }
  for (let j = 0; j < 40; j++) {
    const z = j * 0.6 - (cam % 0.6) + 0.3;
    const [, y] = project(0, 1, z);
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }
  const demonsNow: [number, number][] = [];
  for (let k = 0; k < SWOOP_BEATS.length; k++) {
    for (let back = 0; back < 40; back += 8) {
      const [x, y, z] = swoopAt(k, time - back);
      if (z > 0.2) {
        demonsNow.push(project(x, y, z));
      }
    }
  }
  // Buildings, far to near, each rising out of the ground as it nears.
  const blocks: { side: number; z0: number; z1: number; h: number; id: number }[] = [];
  for (let n = 0; n < 24; n++) {
    const worldZ = n * 1.2;
    const z0 = worldZ - cam + 0.6;
    if (z0 + 1.0 < 0.35) {
      continue;
    }
    for (const side of [-1, 1]) {
      const bid = n * 2 + (side > 0 ? 1 : 0);
      blocks.push({ side, z0: Math.max(0.35, z0), z1: z0 + 1.0, h: 1.2 + 2.6 * hash(bid, 91), id: bid });
    }
  }
  blocks.sort((a, b) => b.z0 - a.z0);
  for (const b of blocks) {
    const rise = smooth(clamp((22 - b.z0) / 6));
    const top = 1 - b.h * rise;
    const X = b.side * 1.1;
    const [ax, ay] = project(X, 1, b.z0);
    const [bx, by] = project(X, 1, b.z1);
    const [cx2, cy2] = project(X, top, b.z1);
    const [dx, dy] = project(X, top, b.z0);
    g.fillStyle = pal.bg;
    g.strokeStyle = pal.line;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.lineTo(cx2, cy2);
    g.lineTo(dx, dy);
    g.closePath();
    g.fill();
    g.stroke();
    // The front face toward the camera.
    const [ex, ey] = project(X + b.side * 1.6, 1, b.z0);
    const [fx, fy] = project(X + b.side * 1.6, top, b.z0);
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(ex, ey);
    g.lineTo(fx, fy);
    g.lineTo(dx, dy);
    g.closePath();
    g.fill();
    g.stroke();
    const cols = 4;
    const rows = Math.max(1, Math.floor(b.h * rise * 3));
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const wz = lerp(b.z0, b.z1, (c + 0.3) / cols);
        const wz2 = lerp(b.z0, b.z1, (c + 0.75) / cols);
        const wy = 1 - (r + 0.3) / 3;
        const [p1x, p1y] = project(X, wy, wz);
        const [p2x, p2y] = project(X, wy - 0.18, wz2);
        let lit = hash(b.id * 50 + c * 7 + r, 92) < 0.18 ? 0.5 : 0;
        for (const [dxp, dyp] of demonsNow) {
          const dd = Math.hypot(dxp - p1x, dyp - p1y);
          if (dd < 160) {
            lit = 1;
          }
        }
        g.fillStyle = lit > 0 ? rgba(pal.hot, lit) : rgba(pal.line, 0.15);
        g.fillRect(Math.min(p1x, p2x), Math.min(p1y, p2y), Math.abs(p2x - p1x), Math.abs(p2y - p1y));
      }
    }
  }
  const boxes: TextBox[] = [];
  const words = ['MY DIAGNOSIS', 'THE DEBT', 'WHAT I SEARCHED', 'MY REAL NAME'];
  for (let k = 0; k < SWOOP_BEATS.length; k++) {
    const [x, y, z] = swoopAt(k, time);
    if (z < 0.25 || z > 12) {
      continue;
    }
    const [sx, sy] = project(x, y, z);
    const size = (0.35 / z) * f;
    demon(g, time, {
      x: sx,
      y: sy,
      size,
      angle: hs(k, 5) * 0.4,
      jaw: 0.6 + 0.4 * Math.sin(time * 0.5 + k),
      seed: k + 40,
      pal: { ...INK, key: HELL.key, line: HELL.line, hot: HELL.hot },
      past: (n) => {
        const [qx, qy, qz] = swoopAt(k, time - n);
        return qz > 0.2 ? project(qx, qy, qz) : [sx, sy];
      },
    });
    if (size < 420) {
      boxes.push(
        imagery(g, ctx, { id: `secret-${String(k)}`, text: words[k] ?? '', x: sx, y: sy + size * 1.05 + 30, size: Math.max(18, size * 0.22), face: 'mono', weight: 700, fill: HELL.key, align: 'center', tracking: 0.05 })
      );
    }
  }
  return boxes;
}

const SECRET = 'MY DIAGNOSIS · THE DEBT · WHAT I SEARCHED · THE AFFAIR · MY REAL NAME · WHERE I LIVE · THE TEST RESULT · ';

/**
 * Beat 32-36: one demon, close, its body a stream of the secrets it carries,
 * screaming at the camera on each of the three hits.
 */
export function exposed(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  const lt = time - start;
  field(g, time, HELL, 1500, 0.5);
  const hits = [bf(32), bf(33), bf(34)];
  const scream = clamp(env(time, hits, 7));
  const hx = CX + 40 * wander(time / 60, 7);
  const hy = 1300 - 20 * scream;
  g.save();
  g.font = fontOf(ctx, 'mono', 700, 30);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const chars = [...SECRET];
  for (let strand = 0; strand < 5; strand++) {
    const phase = strand * 1.3;
    for (let i = 0; i < 44; i++) {
      const s = i / 44;
      const flow = (s + lt * 0.003) % 1;
      const a = phase + flow * 5.5 + Math.sin(time * 0.02 + strand) * 0.4;
      const r = 120 + flow * 720;
      const x = hx + Math.cos(a) * r * 0.7;
      const y = hy + 220 + Math.sin(a) * r * 0.45 + flow * 260;
      // Each letter keeps its place in the strand as the strand flows, so the words stay words.
      const ch = chars[(i + strand * 17) % chars.length] ?? ' ';
      g.save();
      g.translate(x, y);
      g.rotate(a + Math.PI / 2);
      g.fillStyle = rgba(flow < 0.2 ? HELL.hot : HELL.line, 1 - flow * 0.7);
      if (!ctx.hideText) {
        g.fillText(ch, 0, 0);
      }
      g.restore();
    }
  }
  g.restore();
  // One key pose per hit, each springing on from the last, never back to a rest face:
  // SEEN a wide-eyed scream, SOLD a sly squint tilted over, SHARED a lunge, then a roar.
  const keys = [
    { at: bf(32), jaw: 1, eyes: [1.6, 1.5] as const, tilt: -0.1, stretch: 1.2, size: 1 },
    { at: bf(33), jaw: 0.3, eyes: [0.35, 1.5] as const, tilt: 0.24, stretch: 0.88, size: 1.05 },
    { at: bf(34), jaw: 0.85, eyes: [1.3, 0.7] as const, tilt: -0.22, stretch: 1.08, size: 1.22 },
    { at: bf(35), jaw: 1, eyes: [1.7, 1.7] as const, tilt: 0.04, stretch: 1.35, size: 1.32 },
  ];
  const first = keys[0];
  let pose = { jaw: 0.2, e0: 1, e1: 1, tilt: 0, stretch: 1, size: 0.95 };
  for (const k of keys) {
    const w = k === first && time < k.at ? 0 : clamp(springOf(time, k.at, PLAYFUL), 0, 1.3);
    pose = {
      jaw: lerp(pose.jaw, k.jaw, w),
      e0: lerp(pose.e0, k.eyes[0], w),
      e1: lerp(pose.e1, k.eyes[1], w),
      tilt: lerp(pose.tilt, k.tilt, w),
      stretch: lerp(pose.stretch, k.stretch, w),
      size: lerp(pose.size, k.size, w),
    };
  }
  demon(g, time, {
    x: hx,
    y: hy - 60 * (pose.size - 1),
    size: 330 * pose.size * (1 + 0.08 * scream),
    angle: pose.tilt + 0.03 * Math.sin(time * 0.07),
    jaw: clamp(pose.jaw + 0.08 * Math.sin(time * 0.5)),
    seed: 77,
    pal: HELL,
    eyes: [Math.max(0.1, pose.e0), Math.max(0.1, pose.e1)],
    stretch: pose.stretch,
    past: (k) => [hx + 6 * k * Math.sin(k * 0.3), hy + 18 * k],
  });
  return [
    imagery(g, ctx, { id: 'secret-strands', text: 'SECRETS', x: 70, y: 1260, size: 20, face: 'mono', weight: 600, fill: rgba(HELL.line, 0.8), tracking: 0.3 }),
  ];
}

/** The frame the tape stops and the laugh dies: the Devil sees something. */
const TAPE = bf(39.5);

/**
 * Beat 36-40: the Devil laughs; flames burst from his horns and demons ring him,
 * each on its own orbit. On the tape stop (beat 39.5) his eyes snap aside, his
 * head jerks back, the laugh drops into a gape and the halo falls.
 */
export function laugh(g: G, time: number, start: number, frame: number): void {
  const stopped = frame >= TAPE;
  const since = Math.max(0, time - TAPE);
  // After the stop, the halo and flames run down like the tape: time slows to a halt.
  const run = stopped ? TAPE + 8 * (1 - Math.exp(-since / 8)) : time;
  const lt = run - start;
  field(g, time, INK, 1250, 0.6);
  smoke(g, run, '#3a1a06', 0.35);
  const hx = CX;
  const hy = 1360;
  const jerk = stopped ? springOf(time, TAPE, SNAPPY) : 0;
  const scale = (290 + lt * 0.35) * (1 + 0.06 * jerk);
  const tighten = 1 - 0.25 * prog(run, start, start + 96);
  const fall = stopped ? 900 * (since / 60) ** 2 : 0;
  const orbit = (i: number, tt: number): [number, number, number] => {
    const speed = 0.028 + 0.016 * hash(i, 41);
    const a = (i / 12) * TAU + (tt - start) * speed + 0.3 * wander(tt / 60, i + 20);
    const rx = 470 * tighten * (0.82 + 0.3 * hash(i, 42));
    const ry = 150 * tighten * (0.8 + 0.4 * hash(i, 43));
    const bob = 34 * Math.sin((tt / 60) * (1.3 + hash(i, 44)) + i * 1.7);
    return [hx + Math.cos(a) * rx, hy - 380 + Math.sin(a) * ry + bob, a];
  };
  const halo = Array.from({ length: 12 }, (_, i) => {
    const [x, y, a] = orbit(i, run);
    return { x: x + (stopped ? (x - hx) * 0.4 * (since / 60) : 0), y: y + fall * (0.7 + 0.6 * hash(i, 45)), a, i, back: Math.sin(a) < 0 };
  });
  const draw = (back: boolean): void => {
    for (const h of halo.filter((q) => q.back === back)) {
      demon(g, time, {
        x: h.x,
        y: h.y,
        size: (back ? 50 : 80) * (0.85 + 0.3 * hash(h.i, 46)) * (1 + 0.2 * beatPulse(run - h.i * 3)),
        angle: h.a + Math.PI + (stopped ? since * 0.05 * (hash(h.i, 47) - 0.5) : 0),
        jaw: 0.5 + 0.5 * Math.sin(run * (0.2 + 0.2 * hash(h.i, 48)) + h.i),
        seed: h.i + 60,
        pal: HELL,
        past: (k) => {
          const [px, py] = orbit(h.i, run - k);
          return [px, py + fall];
        },
      });
    }
  };
  draw(true);
  const flare = beatPulse(run, FPB / 2, 3);
  const flameLeft = stopped ? Math.exp(-since / 5) : 1;
  for (const side of [-1, 1]) {
    drawFlame(g, run + side * 17, {
      x: hx + side * 0.7 * scale,
      y: hy - 1.85 * scale,
      height: (110 + 110 * flare) * flameLeft,
      width: 60,
      split: 0,
      heat: flameLeft,
      particles: 80,
      seed: side > 0 ? 71 : 73,
    });
  }
  const laughJaw = 0.25 + 0.75 * Math.abs(Math.sin((Math.PI * (time - start)) / (FPB / 2)));
  drawDevil(g, time, {
    x: hx,
    y: hy - 30 * jerk,
    scale,
    draw: 1,
    mood: stopped ? lerp(1, -0.35, clamp(springOf(time, TAPE + 3, DEFAULT))) : 1,
    // The take: the jaw slams shut on the stop, then falls open.
    jaw: stopped ? (since < 3 ? 0 : lerp(0, 0.75, clamp((since - 3) / 8))) : laughJaw,
    tremble: stopped ? 0.012 : 0.004,
    horns: 1,
    line: INK.line,
    eye: INK.key,
    fill: INK.bg,
    lineWidth: 4.5,
    look: stopped ? 1 : 0.25 * Math.sin(time * 0.05),
    tilt: stopped ? -0.08 * jerk : 0.04 * Math.sin((Math.PI * (time - start)) / FPB),
  });
  draw(false);
}
