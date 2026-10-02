import { REST, drawDevil } from './devil.js';
import {
  CAMERA,
  CARD,
  HEAVY,
  PLAYFUL,
  SNAPPY,
  arcPoint,
  clamp,
  easeIn,
  easeInOut,
  easeOut,
  expoOut,
  hashIndex,
  beatIndex,
  hit,
  keyed,
  onBeats,
  keyedLog,
  lerp,
  span,
  step,
  wob,
} from './motion.js';
import {
  AI_BLUE,
  AI_BLUE_DEEP,
  AI_BLUE_LIGHT,
  AI_GLINT,
  BRIM,
  FEATURE,
  FLOOR,
  INK,
  MAW,
  MAW_TYPE,
  MAW_WALL,
  PAPER,
  PAPER_INK,
  TONGUE,
  TOOTH,
} from './palette.js';
import { PLAIN_DEMON, aiBubble, bubblePoints, demon, mark, mix, polygon, rrect } from './shapes.js';
import { F, IMPACT_WEIGHT, ROWS, cueFrame } from './timeline.js';
import { drawRow, fontOf } from './type.js';

import type { LookContext, RenderFrame, TextBox } from '../../../../engine/look/index.js';
import type { DevilPose } from './devil.js';
import type { DemonDesign } from './shapes.js';
import type { Row } from './timeline.js';

type P = CanvasRenderingContext2D;
type Ctx = LookContext<'2d'>;

const W = 1080;
const H = 1920;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Seeded values: one table drawn from ctx.random, indexed by element and tick,
// so every frame reads the same numbers in any order.

const TABLE_SIZE = 4096;
let table: Float64Array | null = null;
let tableSource: Ctx['random'] | null = null;

function seeded(ctx: Ctx): Float64Array {
  if (table === null || tableSource !== ctx.random) {
    const next = ctx.random('table');
    table = new Float64Array(TABLE_SIZE);
    for (let i = 0; i < TABLE_SIZE; i++) {
      table[i] = next();
    }
    tableSource = ctx.random;
  }
  return table;
}

/** A seeded value in [0, 1) for element `i` of stream `k`. */
function rnd(k: number, i: number): number {
  return table![(k * 977 + i * 131) % TABLE_SIZE]!;
}

/** A re-rolling jitter in -1..1 for element `i` at tick `tick`. */
function jitter(i: number, tick: number): number {
  return table![hashIndex(i, tick, TABLE_SIZE)]! * 2 - 1;
}

/** The Devil's outline boil: redrawn twelve times a second. */
function boilAt(t: number, seed: number): (i: number) => number {
  const tick = Math.floor(Math.round(t) / 5);
  return (i) => jitter(i + seed * 97, tick) * 0.007;
}

const row = (id: string): Row => {
  const found = ROWS.find((r) => r.id === id);
  if (found === undefined) {
    throw new Error(`one-take-launch: no row ${id}`);
  }
  return found;
};

// The surface: a tile of seeded grain laid over every frame, shifted to a new
// place twelve times a second, so flat fields read as printed, not rendered.

const GRAIN = 256;
let grain: OffscreenCanvas | null = null;

function grainTile(): OffscreenCanvas {
  if (grain === null) {
    grain = new OffscreenCanvas(GRAIN, GRAIN);
    const gc = grain.getContext('2d')!;
    const img = gc.createImageData(GRAIN, GRAIN);
    for (let i = 0; i < GRAIN * GRAIN; i++) {
      const v = Math.round(table![(i * 7919) % TABLE_SIZE]! * 255);
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    gc.putImageData(img, 0, 0);
  }
  return grain;
}

function drawGrain(g: P, frame: number): void {
  const tick = Math.floor(frame / 5);
  const pattern = g.createPattern(grainTile() as unknown as CanvasImageSource, 'repeat');
  if (pattern === null) {
    return;
  }
  g.save();
  g.globalAlpha = 0.045;
  g.globalCompositeOperation = 'overlay';
  g.translate(-((tick * 97) % GRAIN), -((tick * 61) % GRAIN));
  g.fillStyle = pattern;
  g.fillRect(0, 0, W + GRAIN, H + GRAIN);
  g.restore();
}

// ---------------------------------------------------------------------------
// Camera: a keyed spring chain per act, plus impact shake and punch summed from the cues.

interface Cam {
  cx: number;
  cy: number;
  z: number;
  rot: number;
}

const SHAKE_CUES = Object.entries(IMPACT_WEIGHT).map(([id, w]) => ({ at: cueFrame(id), w }));

function impacts(t: number, frames = 14): number {
  let sum = 0;
  for (const { at, w } of SHAKE_CUES) {
    sum += w * hit(t, at, frames);
  }
  return sum;
}

function applyCam(g: P, cam: Cam, t: number): void {
  let sx = 0;
  let sy = 0;
  let punch = 0;
  for (const [k, { at, w }] of SHAKE_CUES.entries()) {
    const e = w * hit(t, at, 16);
    if (e > 0.001) {
      sx += e * 22 * Math.sin(t * 0.55 + k * 1.7);
      sy += e * 22 * Math.cos(t * 0.71 + k * 2.3);
      punch += e * 0.035;
    }
  }
  g.translate(W / 2 + sx, H / 2 + sy);
  g.rotate(cam.rot + 0.004 * wob(t, 0.3, 0.7));
  g.scale(cam.z * (1 + punch), cam.z * (1 + punch));
  g.translate(-cam.cx, -cam.cy);
}

// ---------------------------------------------------------------------------
// Act one: the Devil's keynote (beats 0–16).

/**
 * Act one's staging was drawn on an earlier grid; this carries each of its beats
 * to where the act now plays them, so the card stack holds under its caption
 * before the pull-out: the pull-out on 11, the eye on 11.5 to 12, the looks on
 * 12.5 and 13, the blink on 13.5 and the cracks on 14, 14.5 and 15.
 */
const ACT_ONE_BEATS: readonly [number, number][] = [
  [8, 11],
  [9, 11.5],
  [10, 12],
  [10.5, 12.5],
  [11, 13],
  [12, 13.5],
  [13, 14],
  [14, 14.5],
  [15, 15],
  [16, 16],
];

/** The frame act one's drawn beat `beat` now plays on. */
function A(beat: number): number {
  for (let i = 1; i < ACT_ONE_BEATS.length; i++) {
    const [b0, n0] = ACT_ONE_BEATS[i - 1]!;
    const [b1, n1] = ACT_ONE_BEATS[i]!;
    if (beat <= b1) {
      return F(n0 + ((beat - b0) / (b1 - b0)) * (n1 - n0));
    }
  }
  return F(beat);
}

const FLOOR_Y = 1380;
const HEAD_X = 540;
const HEAD_Y = 1010;
const HEAD_R = 210;
const EYE_X = 540;
const EYE_Y = 1060;

function actOneCam(t: number): Cam {
  const z = keyedLog(t, 1.34, [
    { at: F(1), to: 1.16, s: CAMERA },
    { at: F(2.5), to: 1.02, s: CAMERA },
    { at: F(4), to: 1.08, s: CAMERA },
    { at: F(7), to: 1.0, s: CAMERA },
    { at: F(8.5), to: 1.07, s: CAMERA },
    { at: F(9.5), to: 1.13, s: CAMERA },
    { at: F(10.5), to: 1.18, s: CAMERA },
    { at: A(8), to: 0.94, s: CARD },
    { at: A(9), to: 1.0, s: CAMERA },
    { at: A(10), to: 1.1, s: CAMERA },
    { at: A(12), to: 1.14, s: CARD },
    { at: A(14), to: 1.6, s: CARD, antic: 0.1 },
    { at: A(15), to: 2.1, s: CARD },
    { at: A(15.5), to: 1.85, s: SNAPPY },
  ]);
  const cy = keyed(t, 1250, [
    { at: F(1), to: 1110, s: CAMERA },
    { at: F(2.5), to: 1000, s: CAMERA },
    { at: F(7), to: 960, s: CAMERA },
    { at: A(9), to: EYE_Y, s: CAMERA },
  ]);
  const cx = keyed(t, 440, [
    { at: F(1), to: 520, s: CAMERA },
    { at: F(2.5), to: 540, s: CAMERA },
    { at: F(7), to: 520, s: CAMERA },
    { at: A(9), to: 540, s: CAMERA },
  ]);
  const rot = keyed(t, 0.045, [
    { at: F(1), to: -0.01, s: CAMERA },
    { at: F(3), to: -0.025, s: CAMERA },
    { at: F(7), to: 0.015, s: CAMERA },
    { at: A(8), to: 0, s: CAMERA },
    { at: A(13), to: 0.03, s: CARD },
    { at: A(14), to: -0.035, s: CARD },
    { at: A(15), to: 0.02, s: CARD },
  ]);
  return { cx, cy, z, rot };
}

/** The Devil's pose through act one: dot, rising head, presenter, then pupil. */
function actOneDevil(t: number): DevilPose | null {
  if (t < F(2.2) || t >= A(12) + 10) {
    return null;
  }
  const bob = wob(t, 0.1, 1.3);
  const x =
    keyed(t, HEAD_X, [
      { at: F(7) + 6, to: 250, s: CARD, antic: 0.08 },
      { at: A(8) + 6, to: EYE_X, s: CARD },
    ]) + irisX(t);
  const y =
    keyed(t, 1660, [
      { at: F(2.3), to: HEAD_Y, s: HEAVY, antic: 0.05 },
      { at: F(7) + 6, to: 1460, s: CARD },
      { at: A(8) + 6, to: EYE_Y, s: CARD },
    ]) +
    bob * 6;
  const r = keyedLog(t, HEAD_R, [
    { at: F(7) + 6, to: 118, s: CARD },
    { at: A(8) + 6, to: 88, s: CARD },
    { at: A(9.7), to: 100, s: HEAVY },
  ]);
  // as the eye's pupil he is stretched tall and keeps his face, grinning out of the eye, until the lids crush him
  const pupil = step(t - A(9.75), HEAVY);
  const lid = 1 - clamp(step(t - A(12) + 2, SNAPPY) * 1.02);
  const sx = lerp(1, 0.6, pupil) * (1 + 0.14 * hit(t, F(3.5), 12)) * lerp(1, 1.3, 1 - lid);
  const sy = lerp(1, 1.55, pupil) * (1 - 0.1 * hit(t, F(3.5), 12)) * lid;
  const features = clamp(step(t - F(3.3), SNAPPY));
  const presenting = clamp(step(t - F(7) - 8, CARD));
  const looking = step(t - A(8) - 6, CARD);
  return {
    ...REST,
    x,
    y,
    r,
    rot: 0.05 * wob(t, 0.7, 1.1) - 0.08 * hit(t, F(7), 20) + 0.06 * looking * Math.sin(t * 0.3) + 0.1 * wink(t) - 0.14 * hit(t, F(6), 24),
    sx,
    sy,
    mood: 1,
    mouth: 0.05 + 0.3 * hit(t, F(7), 20) + 0.45 * hit(t, F(6), 24),
    lookX: lerp(lerp(0, 0.2, clamp(step(t - F(3.5) - 10, SNAPPY))), 1, presenting) * (1 - looking) + (irisX(t) / 130) * pupil,
    lookY: lerp(0, -0.8, presenting) * (1 - looking),
    lidL: 1 - clamp(step(t - F(3.5) + 3, SNAPPY)) + 0.9 * wink(t) + blink(t, F(6.6)) + blink(t, F(9.1)),
    lidR: 1 - clamp(step(t - F(3.5) - 7, SNAPPY)) + blink(t, F(6.6) + 10) + blink(t, F(9.1) + 11),
    hornL: clamp(step(t - F(3) + 6, PLAYFUL) * 1.05) * (1 - 0.55 * pupil),
    hornR: clamp(step(t - F(3) + 2, PLAYFUL) * 1.05) * (1 - 0.55 * pupil),
    droopL: 0.03 * wob(t, 0.2, 2),
    droopR: 0.03 * wob(t, 0.9, 1.7),
    features,
    t,
    grin: t < F(7) ? clamp(step(t - F(3.9), CARD)) : clamp(step(t - F(7) - 14, CARD)),
  };
}

/**
 * The Devil's pose with its trailing parts: each horn and the goatee read the
 * head's motion from a few frames back, the right horn later than the left, so
 * they swing after the head rather than moving with it.
 */
function follow(pose: (t: number) => DevilPose | null, t: number): DevilPose | null {
  const p = pose(t);
  if (p === null) {
    return null;
  }
  const a = pose(t - 3) ?? p;
  const b = pose(t - 6) ?? a;
  const c = pose(t - 9) ?? b;
  const vel = (q: DevilPose, r: DevilPose): { x: number; y: number; rot: number } => ({
    x: (q.x - r.x) / 3 / p.r,
    y: (q.y - r.y) / 3 / p.r,
    rot: (q.rot - r.rot) / 3,
  });
  const vl = vel(p, a);
  const vr = vel(a, b);
  const vc = vel(b, c);
  return {
    ...p,
    droopL: p.droopL + clamp(-vl.y * 6 + vl.x * 5 + vl.rot * 4, -0.35, 0.5),
    droopR: p.droopR + clamp(-vr.y * 6 - vr.x * 5 - vr.rot * 4, -0.35, 0.5),
    chinSway: clamp(-vc.x * 7 - vc.rot * 5, -0.6, 0.6),
  };
}

/** The Devil's wink on beat 5: the left lid shuts and holds a moment. */
function wink(t: number): number {
  return clamp(span(t, F(5) - 3, F(5) + 2)) * (1 - clamp(span(t, F(5) + 12, F(5) + 18)));
}

/** A blink: shut and open over eight frames from `at`. */
function blink(t: number, at: number): number {
  const d = t - at;
  return d < 0 || d > 8 ? 0 : Math.sin((d / 8) * Math.PI);
}

/** Where the dot is launched from: stage left, so its flight is an arc to centre. */
const LAUNCH_X = 380;

/** The dot: launched off the floor at 0, lands and splits at 2, its halves fly up to the horns at 3. */
function drawDot(g: P, t: number): void {
  if (t >= F(3) + 8) {
    return;
  }
  g.fillStyle = BRIM;
  if (t < F(2)) {
    const u = t / F(2);
    const lift = 560 * 4 * u * (1 - u);
    const dx = lerp(LAUNCH_X, 540, u);
    const vy = Math.abs(1 - 2 * u);
    const stretch = 1 + 0.4 * vy * (1 - hit(t, 0, 10)) - 0.45 * hit(t, 0, 12);
    const apex = 0.35 * hit(t, F(1), 12);
    const sy = stretch * (1 - apex);
    const sx = (1 / Math.max(0.4, stretch)) * (1 + apex);
    const rr = 54;
    g.save();
    g.translate(dx, FLOOR_Y - rr * sy - lift);
    g.rotate(u * 1.4);
    g.scale(sx, sy);
    g.beginPath();
    g.arc(0, 0, rr, 0, TAU);
    g.fill();
    g.restore();
    return;
  }
  const split = step(t - F(2), PLAYFUL);
  const fly = clamp(step(t - F(3) + 12, CARD) * 1.02);
  for (const side of [-1, 1]) {
    const bx = 540 + side * 150 * split;
    const by = FLOOR_Y - 30;
    const tx = HEAD_X + side * 0.52 * HEAD_R;
    const ty = HEAD_Y - 0.74 * HEAD_R;
    const lag = side === 1 ? 4 : 0;
    const u = clamp(step(t - F(3) + 12 - lag, CARD));
    const [px, py] = arcPoint(bx, by, tx, ty, u, side * 120);
    const rr = lerp(34, 18, fly) * (1 - span(t, F(3) - 2, F(3) + 6));
    const squash = 1 - 0.4 * hit(t, F(2), 10);
    g.save();
    g.translate(px, py - (1 - u) * 0);
    g.scale(1 / squash, squash);
    g.beginPath();
    g.arc(0, 0, Math.max(0, rr), 0, TAU);
    g.fill();
    g.restore();
  }
}

/** Sparks kicked off an impact: short streaks flung out along arcs, falling. */
function drawSparks(g: P, t: number, at: number, x: number, y: number): void {
  const d = t - at + 4;
  if (d < 0 || d > 34) {
    return;
  }
  g.strokeStyle = BRIM;
  g.lineCap = 'round';
  for (let k = 0; k < 12; k++) {
    const a = -Math.PI * (0.08 + 0.84 * rnd(90, k + at));
    const v = 9 + 12 * rnd(91, k + at);
    const px = x + Math.cos(a) * v * d;
    const py = y + Math.sin(a) * v * d + 0.35 * d * d;
    const qx = px - Math.cos(a) * v * 2.2;
    const qy = py - (Math.sin(a) * v + 0.7 * d) * 2.2;
    g.lineWidth = 6 * (1 - d / 34);
    g.beginPath();
    g.moveTo(px, py);
    g.lineTo(qx, qy);
    g.stroke();
  }
}

function drawRing(g: P, t: number, at: number, x: number, y: number, radius: number, color: string, width: number): void {
  const d = t - at;
  if (d < 0 || d > 30) {
    return;
  }
  const u = easeOut(d / 30);
  g.beginPath();
  g.arc(x, y, 30 + radius * u, 0, TAU);
  g.lineWidth = width * (1 - u);
  g.strokeStyle = color;
  g.stroke();
}

/** The keynote spotlight: a cone from the flies onto the stage, following the Devil, closing like an iris at the pull-out. */
function drawSpot(g: P, t: number): void {
  const close = easeIn(span(t, A(8) - 6, A(8) + 4));
  if (close >= 1) {
    return;
  }
  const x = keyed(t, LAUNCH_X, [
    { at: F(0.4), to: 540, s: CAMERA },
    { at: F(7) + 6, to: 250, s: CARD },
  ]);
  const floorY = keyed(t, FLOOR_Y, [{ at: F(7) + 6, to: 1640, s: CARD }]);
  const spread = (320 + 30 * Math.sin(t * 0.05)) * (1 - close);
  const grad = g.createLinearGradient(0, -200, 0, floorY);
  grad.addColorStop(0, 'rgba(255,240,220,0.02)');
  grad.addColorStop(1, 'rgba(255,240,220,0.11)');
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(x - 90 * (1 - close), -200);
  g.lineTo(x + 90 * (1 - close), -200);
  g.lineTo(x + spread, floorY);
  g.lineTo(x - spread, floorY);
  g.closePath();
  g.fill();
  g.beginPath();
  g.ellipse(x, floorY, spread, 46 * (1 - close), 0, 0, TAU);
  g.fillStyle = 'rgba(255,240,220,0.09)';
  g.fill();
}

function drawFloor(g: P, t: number): void {
  const grow = expoOut((t + 16) / 34);
  const shrink = easeIn(span(t, F(7), A(8)));
  const half = 560 * grow * (1 - shrink);
  if (half < 1) {
    return;
  }
  g.fillStyle = FLOOR;
  g.fillRect(540 - half, FLOOR_Y, half * 2, 4);
  // footlights: a row of small ticks that bounce on the beat, each on its own phase
  for (let i = 0; i < 9; i++) {
    const x = 540 + (i - 4) * 112;
    if (Math.abs(x - 540) > half) {
      continue;
    }
    const beatPulse = onBeats(t, 30, 0, 10) * (0.5 + 0.5 * rnd(3, i));
    const h = 8 + 26 * beatPulse + 6 * wob(t, rnd(4, i), 2);
    g.fillRect(x - 3, FLOOR_Y + 14, 6, Math.max(2, h));
  }
}

/** The grin, peeled off the face and morphing into the first AI card. */
const CARD_W = 620;
const CARD_H = 250;
const CARD_X = 580;
const CARD_Y = 930;

function grinPoints(n: number): [number, number][] {
  const pts: [number, number][] = [];
  const half = n / 2;
  for (let i = 0; i < half; i++) {
    const x = -1 + (2 * i) / (half - 1);
    pts.push([x * 0.6, 0.3 - 0.2 * x * x]);
  }
  for (let i = 0; i < half; i++) {
    const x = 1 - (2 * i) / (half - 1);
    pts.push([x * 0.6, 0.3 - 0.2 * x * x + 0.035 + 0.1 * (1 - x * x)]);
  }
  return pts;
}

function drawCards(g: P, t: number): void {
  if (t < F(7) - 2 || t >= A(8) + 2) {
    return;
  }
  const n = 48;
  const cards = [F(7), F(7.5), F(8.5), F(9.5), F(10.5)];
  // oldest first: each new card lands in front of the stack it pushes back
  for (let k = 0; k < cards.length; k++) {
    const born = cards[k]!;
    if (t < born - 2) {
      continue;
    }
    const depth = cards.filter((c, j) => j > k && t >= c - 2).reduce((sum, c) => sum + step(t - c + 2, CARD), 0);
    const y = CARD_Y - 44 * depth;
    const s = Math.pow(0.9, depth);
    const shade = clamp(depth * 0.22);
    g.save();
    if (k === 0) {
      // the peel: from the Devil's mouth, along an arc, crescent to bubble
      const u = clamp(step(t - born + 2, CARD));
      const shape = clamp(span(t, born - 2, born + 16));
      const mouthX = HEAD_X;
      const mouthY = HEAD_Y + 0.38 * HEAD_R;
      const [px, py] = arcPoint(mouthX, mouthY, CARD_X, y, u, -140);
      g.translate(px, py);
      g.rotate(lerp(-0.4, 0.02 * Math.sin(t * 0.05), u));
      const crescent = grinPoints(n).map(([x, yy]) => [x * HEAD_R, (yy - 0.36) * HEAD_R] as [number, number]);
      const bubble = bubblePoints(CARD_W * s, CARD_H * s, n);
      const pts = crescent.map(([x, yy], i) => [lerp(x, bubble[i]![0], shape), lerp(yy, bubble[i]![1], shape)] as [number, number]);
      polygon(g, pts);
      g.fillStyle = mix(FEATURE, AI_BLUE, shape);
      g.fill();
      if (shape >= 1) {
        const typed = span(t, F(7) + 12, F(7) + 26);
        g.save();
        aiBubble(g, { w: CARD_W * s, h: CARD_H * s, typed, fill: mix(AI_BLUE, AI_BLUE_DEEP, shade) });
        g.restore();
      }
    } else {
      const pop = step(t - born + 2, SNAPPY);
      g.translate(CARD_X + (k % 2 === 0 ? 8 : -8) * depth + (1 - pop) * (k % 2 === 0 ? 120 : -120), y + (1 - pop) * 160);
      g.rotate((k % 2 === 0 ? 1 : -1) * 0.02 * depth + 0.015 * Math.sin(t * 0.06 + k));
      g.scale(pop * s, pop * s);
      aiBubble(g, { w: CARD_W, h: CARD_H, typed: span(t, born + 2, born + 12), fill: mix(AI_BLUE, AI_BLUE_DEEP, shade) });
    }
    g.restore();
  }
}

// The swarm: 240 small cards, from the stack to a grid, to the eye, to the closed lid's line.
const SWARM = 240;
const COLS = 12;

interface Mini {
  x: number;
  y: number;
  s: number;
  rot: number;
  hue: number;
}

/** Where the iris has darted to: left, right, centre on the look cues. */
function irisX(t: number): number {
  return keyed(t, 0, [
    { at: A(10.5) - 7, to: -130, s: SNAPPY },
    { at: A(11) - 7, to: 130, s: SNAPPY },
    { at: A(11.5) - 7, to: 0, s: SNAPPY },
  ]);
}

function eyeTarget(i: number, t: number): { x: number; y: number; rot: number; s: number } {
  const lid = 1 - clamp(step(t - A(12) + 2, SNAPPY) * 1.02);
  const ix = irisX(t);
  const upper = (x: number): number => EYE_Y - 300 * lid * (1 - x * x) ** 0.85;
  const lower = (x: number): number => EYE_Y + 230 * lid * (1 - x * x) ** 0.85;
  const slope = (f: (x: number) => number, x: number): number => Math.atan2(f(x + 0.01) - f(x - 0.01), 0.02 * 440);
  if (i < 56) {
    const x = -0.98 + (1.96 * i) / 55;
    return { x: EYE_X + x * 440, y: upper(x), rot: slope(upper, x), s: 1 };
  }
  if (i < 104) {
    const x = -0.95 + (1.9 * (i - 56)) / 47;
    return { x: EYE_X + x * 440, y: lower(x), rot: slope(lower, x), s: 0.9 };
  }
  if (i < 134) {
    const x = -0.8 + (1.6 * (i - 104)) / 29;
    return { x: EYE_X + x * 440, y: upper(x) - 46 * lid, rot: slope(upper, x), s: 0.8 };
  }
  if (i < 162) {
    const lash = Math.floor((i - 134) / 4);
    const along = (i - 134) % 4;
    const x = -0.72 + (1.44 * lash) / 6;
    const out = 64 + along * 32;
    const ang = -Math.PI / 2 + x * 0.9;
    return {
      x: EYE_X + x * 440 + Math.cos(ang) * out * lid,
      y: upper(x) - 46 * lid + Math.sin(ang) * out * lid,
      rot: ang + Math.PI / 2,
      s: 0.7 - along * 0.1,
    };
  }
  const ring = i < 206 ? 0 : 1;
  const k = ring === 0 ? i - 162 : i - 206;
  const count = ring === 0 ? 44 : 34;
  const a = (k / count) * TAU + t * (ring === 0 ? 0.004 : -0.006);
  const rad = ring === 0 ? 188 : 138;
  return {
    x: EYE_X + ix + Math.cos(a) * rad,
    y: EYE_Y + Math.sin(a) * rad * lid,
    rot: a + Math.PI / 2,
    s: ring === 0 ? 0.8 : 0.62,
  };
}

/** The crack's zig-zag: its centre line's height at x, opening by `gap`. */
function crackY(x: number, t: number): number {
  const kink = step(t - A(13), SNAPPY);
  const n = 11;
  const u = (x - 60) / 960;
  const k = Math.floor(clamp(u, 0, 0.9999) * n);
  const f = clamp(u) * n - k;
  const hA = (k % 2 === 0 ? 1 : -1) * (0.5 + rnd(7, k));
  const hB = ((k + 1) % 2 === 0 ? 1 : -1) * (0.5 + rnd(7, k + 1));
  return EYE_Y + lerp(hA, hB, f) * 42 * kink;
}

function crackGap(t: number): number {
  return keyed(t, 0, [
    { at: A(14), to: 38, s: CARD },
    { at: A(15), to: 120, s: CARD },
    { at: A(15.5), to: 80, s: SNAPPY },
    { at: F(16), to: 1400, s: { w: 14, z: 0.9 } },
  ]);
}

function miniAt(i: number, t: number): Mini {
  const col = i % COLS;
  const rw = Math.floor(i / COLS);
  // the grid fills the frame below the caption, and each card keeps its own jitter, timing and spring
  const gx = 45 + col * 90;
  const gy = 700 + rw * 60;
  const dist = Math.hypot(gx - CARD_X, gy - CARD_Y) / 1100;
  const burst = step(t - A(8) - dist * 5 - rnd(17, i) * 5, { w: 24 + 14 * rnd(18, i), z: 0.45 + 0.25 * rnd(19, i) });
  const sx = CARD_X + (rnd(10, i) - 0.5) * CARD_W;
  const sy = CARD_Y + (rnd(11, i) - 0.5) * CARD_H;
  const [bx, by] = arcPoint(sx, sy, gx, gy, clamp(burst), (rnd(12, i) - 0.5) * 300);
  const jig = clamp(burst);
  let x = bx + (burst - clamp(burst)) * (gx - sx) + jig * 11 * Math.sin(t * (0.08 + 0.12 * rnd(20, i)) + rnd(21, i) * TAU);
  let y = by + (burst - clamp(burst)) * (gy - sy) + jig * 9 * Math.sin(t * (0.07 + 0.12 * rnd(22, i)) + rnd(23, i) * TAU);
  let s = lerp(0.35, 0.8, clamp(burst));
  let rot = (rnd(13, i) - 0.5) * 0.3 * (1 - clamp(burst));
  // to the eye, on arcs, staggered by where each lands
  const e = eyeTarget(i, t);
  const delay = 4 + rnd(14, i) * 12;
  const fly = step(t - A(9) - delay, CARD);
  const [ex, ey] = arcPoint(gx, gy, e.x, e.y, clamp(fly), (rnd(15, i) - 0.5) * 200);
  x = lerp(x, ex + (fly - clamp(fly)) * (e.x - gx), clamp(fly));
  y = lerp(y, ey + (fly - clamp(fly)) * (e.y - gy), clamp(fly));
  s = lerp(s, e.s * 0.72, clamp(fly));
  rot = lerp(rot, e.rot, clamp(fly));
  // closed: shrink to beads riding the crack
  const bead = step(t - A(12) - 4, CARD);
  if (t >= A(12)) {
    const lineX = lerp(e.x, 70 + (i / SWARM) * 940, clamp(bead));
    x = lineX;
    y = lerp(e.y, crackY(lineX, t), clamp(bead));
    s = lerp(s, 0.22, clamp(bead));
    rot = lerp(rot, 0, clamp(bead));
    const gap = crackGap(t);
    if (gap > 0.5) {
      y += (i % 2 === 0 ? -1 : 1) * gap * 0.5;
    }
  }
  return { x, y, s, rot, hue: rnd(16, i) };
}

function drawSwarm(g: P, t: number): void {
  if (t < A(8) || t >= F(16) + 1) {
    return;
  }
  for (let i = 0; i < SWARM; i++) {
    const m = miniAt(i, t);
    if (m.s <= 0.01) {
      continue;
    }
    g.save();
    g.translate(m.x, m.y);
    g.rotate(m.rot);
    g.scale(m.s, m.s);
    const fill = m.hue < 0.55 ? AI_BLUE : m.hue < 0.85 ? AI_BLUE_LIGHT : AI_GLINT;
    polygon(g, bubblePoints(78, 62, 20, 0.8));
    g.fillStyle = fill;
    g.fill();
    g.restore();
  }
}

/** The sclera: a dark-blue lens that grows from the eye's centre as the swarm lands, and shuts with the lids. */
function drawSclera(g: P, t: number): void {
  const open = clamp(step(t - A(9) - 8, HEAVY)) * (1 - clamp(step(t - A(12) + 2, SNAPPY) * 1.02));
  if (open <= 0.01 || t >= A(12) + 20) {
    return;
  }
  g.beginPath();
  for (let i = 0; i <= 40; i++) {
    const x = -1 + (2 * i) / 40;
    const y = EYE_Y - 300 * open * (1 - x * x) ** 0.85;
    g.lineTo(EYE_X + x * 440 * open, y);
  }
  for (let i = 40; i >= 0; i--) {
    const x = -1 + (2 * i) / 40;
    g.lineTo(EYE_X + x * 440 * open, EYE_Y + 230 * open * (1 - x * x) ** 0.85);
  }
  g.closePath();
  const grad = g.createRadialGradient(EYE_X, EYE_Y, 20, EYE_X, EYE_Y, 460);
  grad.addColorStop(0, '#1d2d8a');
  grad.addColorStop(1, '#0a1140');
  g.fillStyle = grad;
  g.fill();
}

/** The crack: once the lids shut, a white seam that kinks, opens and bursts. */
function drawCrack(g: P, t: number): void {
  if (t < A(12) + 4 || t >= F(16) + 30) {
    return;
  }
  const gap = crackGap(t);
  const n = 48;
  const top: [number, number][] = [];
  const bottom: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const x = -400 + (i / n) * (W + 800);
    const y = crackY(x, t);
    top.push([x, y - gap / 2]);
    bottom.push([x, y + gap / 2]);
  }
  g.beginPath();
  g.moveTo(top[0]![0], top[0]![1]);
  for (const [x, y] of top) {
    g.lineTo(x, y);
  }
  for (let i = bottom.length - 1; i >= 0; i--) {
    g.lineTo(bottom[i]![0], bottom[i]![1]);
  }
  g.closePath();
  g.fillStyle = PAPER;
  g.fill();
  const seam = clamp(span(t, A(12) + 4, A(12) + 16));
  g.lineWidth = 5 * seam + gap * 0;
  g.strokeStyle = PAPER;
  g.stroke();
  // branches: hairline cracks off the seam, lengthening with each hit
  const reach = keyed(t, 0, [
    { at: A(14), to: 90, s: SNAPPY },
    { at: A(15), to: 260, s: SNAPPY },
  ]);
  if (reach > 2 && gap < 400) {
    g.lineWidth = 4;
    for (let k = 0; k < 9; k++) {
      const x0 = 120 + k * 105 + rnd(20, k) * 40;
      const y0 = crackY(x0, t) + (k % 2 === 0 ? -1 : 1) * gap * 0.5;
      const dir = k % 2 === 0 ? -1 : 1;
      const len = reach * (0.5 + rnd(21, k));
      g.beginPath();
      g.moveTo(x0, y0);
      const mx = x0 + (rnd(22, k) - 0.5) * len * 0.6;
      const my = y0 + dir * len * 0.5;
      g.lineTo(mx, my);
      g.lineTo(mx + (rnd(23, k) - 0.5) * len * 0.5, my + dir * len * 0.5);
      g.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// Act two: the leak (beats 16–28).

const FLOCK = 36;
const FACE_X = 540;
const FACE_Y = 1180;
const FACE_R = 400;

/** Where flock demon `j` sits in the Devil's face the flock builds: outline, horns, then grin. */
function faceTarget(j: number): { x: number; y: number } {
  if (j < 22) {
    const a = (j / 22) * TAU - Math.PI / 2;
    const s = Math.sin(a);
    const chin = Math.max(0, s) ** 7 * 0.34;
    return { x: FACE_X + Math.cos(a) * 1.04 * FACE_R, y: FACE_Y + (s * 0.94 + chin) * FACE_R };
  }
  if (j < 30) {
    const side = j < 26 ? -1 : 1;
    const k = (j - 22) % 4;
    const u = (k + 1) / 4.3;
    const bx = side * 0.52;
    const by = -0.74;
    const tx = bx + Math.cos(-Math.PI / 2 + side * 0.62) * 0.95 + side * 0.22;
    const ty = by + Math.sin(-Math.PI / 2 + side * 0.62) * 0.95;
    const cx = bx + side * 0.46;
    const cy = by - 0.18;
    const v = 1 - u;
    return {
      x: FACE_X + (v * v * bx + 2 * v * u * cx + u * u * tx) * FACE_R,
      y: FACE_Y + (v * v * by + 2 * v * u * cy + u * u * ty) * FACE_R,
    };
  }
  const x = -1 + (2 * (j - 30)) / 5;
  return { x: FACE_X + x * 0.5 * FACE_R, y: FACE_Y + (0.34 - 0.2 * x * x) * FACE_R };
}

/** Flock demon `j`'s own build: horns, wings, eyes, teeth and tail all seeded apart. */
function designOf(j: number): DemonDesign {
  return {
    horn: 0.5 + rnd(200, j) * 1.2,
    curl: rnd(201, j) * 2 - 1,
    wing: 0.7 + rnd(202, j) * 0.7,
    scallops: 2 + Math.floor(rnd(203, j) * 3),
    eyes: rnd(204, j) < 0.55 ? 0 : rnd(204, j) < 0.8 ? 1 : 2,
    teeth: 3 + Math.floor(rnd(205, j) * 5),
    tail: rnd(206, j) < 0.45 ? 0 : 0.5 + rnd(207, j) * 0.8,
  };
}

/**
 * The reaction flock demon `j` gives on the beat it is on: a seeded few chomp,
 * snap their wings, spin or hop, and most carry on, a different few each beat.
 */
function beatReaction(j: number, t: number): { grin: number; flap: number; spin: number; hop: number } {
  const k = beatIndex(t, 30);
  const e = onBeats(t, 30, 0, 12);
  const r = rnd(300 + (k % 60), j);
  return {
    grin: r < 0.22 ? 1 + 0.9 * e : 1,
    flap: r >= 0.22 && r < 0.42 ? 0.9 * e : 0,
    spin: r >= 0.42 && r < 0.54 ? (rnd(301, j) < 0.5 ? -1 : 1) * 1.2 * e : 0,
    hop: r >= 0.54 && r < 0.66 ? 50 * e : 0,
  };
}

function flockAt(j: number, t: number): { x: number; y: number; s: number; rot: number; flap: number; flapR: number; m: number } {
  const born = F(16) + (j % 6);
  const sx = 70 + (j / FLOCK) * 940;
  const sy = EYE_Y;
  // a shared drift kept small; each member wanders on its own rates, so the flock never shifts as a block
  const cx = 540 + 60 * Math.sin(t * 0.021) + 190 * Math.sin(t * (0.012 + 0.022 * rnd(50, j)) + rnd(51, j) * TAU);
  const cy = keyed(t, 1290, [
    { at: F(20), to: 1000, s: CAMERA },
    { at: F(23), to: 1180, s: CAMERA },
  ]) + 150 * Math.sin(t * (0.01 + 0.02 * rnd(52, j)) + rnd(53, j) * TAU);
  const rad = (200 + 320 * rnd(30, j)) * (1 + 0.25 * Math.sin(t * (0.015 + 0.03 * rnd(56, j)) + rnd(57, j) * TAU));
  const dir = rnd(31, j) < 0.3 ? -1 : 1;
  const a = rnd(32, j) * TAU + dir * t * (0.016 + 0.014 * rnd(33, j));
  const ox = cx + Math.cos(a) * rad;
  const oy = cy + Math.sin(a) * rad * 0.62 + Math.sin(a * 2 + rnd(38, j) * TAU) * 110;
  const out = step(t - born, CARD);
  // the burst: straight out from the seam, overshooting, then into orbit
  const burstX = sx + (sx - 540) * 0.35 * hit(t, born, 30);
  const burstY = sy + (rnd(34, j) - 0.5) * 900 * hit(t, born, 30);
  let x = lerp(burstX, ox, clamp(out));
  let y = lerp(burstY, oy, clamp(out));
  const conv = easeInOut(span(t, F(23) - 12 + rnd(54, j) * 20, F(24) - 2 - rnd(55, j) * 8));
  const target = faceTarget(j);
  if (conv > 0) {
    const ang = conv * Math.PI * (0.4 + 0.9 * rnd(58, j)) * (rnd(59, j) < 0.35 ? -1 : 1);
    const dx = x - target.x;
    const dy = y - target.y;
    const k = 1 - conv;
    x = target.x + (dx * Math.cos(ang) - dy * Math.sin(ang)) * k;
    y = target.y + (dx * Math.sin(ang) + dy * Math.cos(ang)) * k;
  }
  const depth = 0.7 + 0.75 * rnd(35, j);
  const mergeAt = F(24) - 4 + rnd(60, j) * 12;
  const merge = 1 - clamp(span(t, mergeAt, mergeAt + 8));
  return {
    x,
    y,
    s: lerp(0.25, depth, clamp(out)) * lerp(1, 0.75, conv) * merge,
    rot: ((rnd(39, j) - 0.5) * 0.8 + 0.25 * Math.sin(t * (0.03 + 0.04 * rnd(40, j)) + j)) * (1 - conv),
    flap: (0.3 + 0.5 * rnd(41, j)) * Math.sin(t * (0.25 + 0.35 * rnd(36, j)) + rnd(37, j) * TAU),
    flapR: (0.3 + 0.5 * rnd(42, j)) * Math.sin(t * (0.25 + 0.35 * rnd(36, j)) + rnd(37, j) * TAU + 0.3 + rnd(43, j) * 0.9),
    m: clamp(span(t, born, born + 16)),
  };
}

function drawFlock(g: P, t: number): void {
  if (t < F(16) || t >= F(24) + 18) {
    return;
  }
  for (let j = 0; j < FLOCK; j++) {
    const d = flockAt(j, t);
    if (d.s <= 0.01) {
      continue;
    }
    // each banks into its own heading, read from where it was two frames back
    const back = flockAt(j, t - 2);
    const bank = clamp((d.x - back.x) * 0.012, -0.5, 0.5);
    const react = beatReaction(j, t);
    const design = designOf(j);
    g.save();
    g.translate(d.x, d.y - react.hop);
    g.rotate(d.rot + bank + react.spin);
    g.scale(d.s, d.s);
    demon(g, {
      w: 110 + 50 * rnd(44, j),
      h: 80 + 26 * rnd(45, j),
      m: d.m,
      flap: d.flap + react.flap,
      flapR: d.flapR + react.flap * 0.8,
      grin: react.grin,
      look: Math.sin(t * (0.02 + 0.03 * rnd(46, j)) + j),
      design,
    });
    g.restore();
  }
  // swoop-2: one demon crosses close to the lens, huge
  const d = t - F(19) + 14;
  if (d > 0 && d < 40) {
    const u = d / 40;
    g.save();
    g.translate(lerp(1700, -700, easeInOut(u)), 1500 - 300 * Math.sin(u * Math.PI));
    g.rotate(-0.25 + u * 0.3);
    g.scale(6, 6);
    demon(g, { w: 130, h: 92, m: 1, flap: 0.6 * Math.sin(t * 0.3), design: { ...PLAIN_DEMON, horn: 1.5, curl: 0.6, eyes: 1, tail: 1 } });
    g.restore();
  }
}

/** A hero demon carrying a secret written across its body. */
function drawHero(g: P, t: number, ctx: Ctx, heroRow: Row, from: number, to: number, swoop: number, side: number): TextBox | null {
  if (t < from || t >= to) {
    return null;
  }
  const enter = step(t - from + 2, { w: 22, z: 0.6 });
  const leave = easeIn(span(t, to - 12, to));
  // a smooth lunge, not an instant jump: the secret written on the body must stay sharp under motion blur
  const ld = t - swoop + 3;
  const lunge = ld < 0 ? 0 : (1 - Math.exp(-ld / 4)) * Math.exp(-ld / 16) * 1.5;
  const sx = side < 0 ? 540 : 1500;
  const sy = side < 0 ? EYE_Y : 700;
  const x = lerp(sx, 540, clamp(enter)) + (enter - clamp(enter)) * (540 - sx) + leave * -side * 1100 + 18 * wob(t, 0.4, 3);
  const y = lerp(sy, 880, clamp(enter)) + (enter - clamp(enter)) * (880 - sy) - leave * 500 + 14 * wob(t, 0.8, 2.6) + lunge * 30;
  const s = lerp(0.3, 1, clamp(enter)) * (1 + 0.16 * lunge) * (1 - leave * 0.4);
  const bw = 940;
  const bh = 310;
  g.save();
  g.translate(x, y);
  g.rotate(-0.05 * side + 0.03 * Math.sin(t * 0.07) - lunge * 0.05 * side);
  g.scale(s, s);
  demon(g, { w: bw, h: bh, m: clamp(span(t, from + 2, from + 20)), flap: 0.55 * Math.sin(t * 0.33), grin: 0 });
  g.restore();
  // the secret, set in the body
  const size = 62;
  g.save();
  g.font = fontOf(heroRow, size, ctx);
  const words = heroRow.words.split(' ');
  const half = Math.ceil(words.length / 2);
  const lines = [words.slice(0, half).join(' '), words.slice(half).join(' ')];
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  g.translate(x, y);
  g.rotate(-0.05 * side + 0.03 * Math.sin(t * 0.07) - lunge * 0.05 * side);
  g.scale(s, s);
  for (const [i, line] of lines.entries()) {
    const baseline = 52 + i * 72;
    if (!ctx.hideText) {
      g.fillStyle = PAPER;
      g.fillText(line, 0, baseline);
    }
    const m = g.measureText(line);
    left = Math.min(left, -m.actualBoundingBoxLeft);
    right = Math.max(right, m.actualBoundingBoxRight);
    top = Math.min(top, baseline - m.actualBoundingBoxAscent);
    bottom = Math.max(bottom, baseline + m.actualBoundingBoxDescent);
  }
  g.restore();
  return {
    id: heroRow.id,
    text: heroRow.words,
    box: { x: x + left * s, y: y + top * s, width: (right - left) * s, height: (bottom - top) * s },
    fontSizePx: size * s,
    role: heroRow.role,
  };
}

/**
 * The four laughs, each its own pose: a toss to the left, a bob to the right,
 * the head thrown back with the jaw widest, then a lunge at the lens.
 */
const LAUGHS = [
  { beat: 25, jaw: 1.1, tilt: -0.1, dy: -20, dx: -30, lookY: -0.3, surge: 0, squeezeL: 0.7, squeezeR: 0.4 },
  { beat: 25.5, jaw: 0.8, tilt: 0.07, dy: 10, dx: 26, lookY: 0, surge: 0, squeezeL: 0.3, squeezeR: 0.75 },
  { beat: 26, jaw: 1.7, tilt: -0.03, dy: -70, dx: 0, lookY: -1, surge: 0, squeezeL: 0.2, squeezeR: 0.25 },
  { beat: 26.5, jaw: 1.3, tilt: 0.12, dy: 30, dx: 10, lookY: 0.2, surge: 0.1, squeezeL: 0.8, squeezeR: 0.8 },
] as const;

/** A laugh's envelope: a quick rise over a few frames, a longer fall. */
function laughEnv(t: number, beat: number): number {
  const d = t - F(beat) + 2;
  return d <= 0 ? 0 : (1 - Math.exp(-d / 2.5)) * Math.exp(-d / 11) * 1.5;
}

function giantPose(t: number): DevilPose {
  const grow = step(t - F(24) + 4, HEAVY);
  const dive = step(t - F(27.5), SNAPPY);
  let jaw = 0;
  let tilt = 0;
  let dy = 0;
  let dx = 0;
  let lookY = -0.2;
  let surge = 0;
  let squeezeL = 0;
  let squeezeR = 0;
  for (const laugh of LAUGHS) {
    const e = laughEnv(t, laugh.beat);
    jaw += laugh.jaw * e;
    tilt += laugh.tilt * e;
    dy += laugh.dy * e;
    dx += laugh.dx * e;
    lookY += laugh.lookY * e * 0.8;
    surge += laugh.surge * e;
    squeezeL += laugh.squeezeL * clamp(e);
    // the right eye squeezes a few frames after the left, never on the same frames
    squeezeR += laugh.squeezeR * clamp(laughEnv(t - 5, laugh.beat));
  }
  return {
    ...REST,
    x: FACE_X + 10 * wob(t, 0.2, 1.4) + dx,
    y: FACE_Y + dy + 8 * wob(t, 0.5, 1.2),
    r: FACE_R * grow * keyedLog(t, 1, [{ at: F(24.5), to: 1.16, s: CAMERA }]) * (1 + surge),
    rot: tilt + 0.02 * wob(t, 0.9, 1),
    sx: 1 + 0.05 * jaw,
    sy: 1 - 0.04 * jaw + 0.04 * hit(t, F(24), 16),
    mood: 1,
    mouth: 0.3 + jaw * 0.8 + dive * 1.1,
    lookX: 0.1 * wob(t, 0.3, 2),
    lookY,
    lidL: 0.15 + clamp(squeezeL) * 0.7 + blink(t, F(24.5) + 6),
    lidR: 0.1 + clamp(squeezeR) * 0.7 + blink(t, F(24.5) + 13),
    hornL: grow,
    hornR: grow,
    droopL: 0,
    droopR: 0,
    features: clamp(span(t, F(24) - 2, F(24) + 8)),
    t,
    grin: 1,
  };
}

// ---------------------------------------------------------------------------
// Act three: inside the mouth, the box, the blast (beats 28–32).

const BOX_SIZE = 340;
/** Where the box lands in the mouth: sitting on the tongue. */
const BOX_REST = 1255;

/** The box's resting place in the mouth, then presented at centre on the white. */
function boxAt(t: number): { x: number; y: number; sx: number; sy: number; rot: number } {
  const land = F(30);
  if (t < land) {
    const d = t - (land - 16);
    const y = d < 0 ? -400 : -400 + 0.5 * ((BOX_REST + 400) * 2 / 256) * d * d;
    return { x: 540, y, sx: 0.9, sy: 1.15, rot: 0.1 };
  }
  const settle = step(t - land, PLAYFUL);
  const squash = 1 - 0.32 * (1 - settle);
  // after the blast it rises on the white, then travels a new place for every value
  const x = keyed(t, 540, [
    { at: F(32) + 4, to: 650, s: HEAVY },
    { at: F(36), to: 580, s: CARD },
    { at: F(40), to: 660, s: CARD },
    { at: F(44), to: 720, s: CAMERA },
    { at: F(47.5), to: BOX_X, s: CARD },
  ]);
  const y = keyed(t, BOX_REST, [
    { at: F(32) + 4, to: 1480, s: HEAVY },
    { at: F(36), to: 1250, s: CARD },
    { at: F(40), to: 1300, s: CARD },
    { at: F(44), to: 1420, s: CAMERA },
    { at: F(47.5), to: BOX_Y, s: CARD },
  ]);
  const hover = 16 * Math.sin(t * 0.08) * clamp(span(t, F(36), F(36) + 20)) * (1 - clamp(span(t, F(39.5), F(40))));
  const bite = [F(31), F(31.5)].reduce((sum, at) => sum + hit(t, at, 10), 0);
  const struck = hit(t, F(34), 14) + hit(t, F(35), 14);
  const pulse = 0.14 * hit(t, F(38), 14);
  return {
    x: x + 6 * Math.sin(t * 1.3) * hit(t, F(31), 20) + 22 * struck,
    y: y + (1 - squash) * BOX_SIZE * 0.5 + hover,
    sx: (1 / squash + 0.05 * bite) * (1 + pulse),
    sy: (squash - 0.05 * bite) * (1 + pulse),
    rot: 0.1 * (1 - clamp(settle)) + 0.06 * (hit(t, F(34), 14) - hit(t, F(35), 14)),
  };
}

function drawBoxShape(g: P, ctx: Ctx, size: number): void {
  const half = size / 2;
  rrect(g, -half, -half + size * 0.05, size, size, size * 0.2);
  g.fillStyle = mix(ctx.brand.brandRed, '#000000', 0.3);
  g.fill();
  rrect(g, -half, -half, size, size, size * 0.2);
  g.fillStyle = ctx.brand.brandRed;
  g.fill();
}

/** Teeth rows framing the mouth: they slide in, pulse on the heartbeats, bite on the splats and blow away on the blast. */
function drawMaw(g: P, t: number, part: 'tongue' | 'teeth'): void {
  const inTop = keyed(t, -320, [{ at: F(28), to: 0, s: CARD }]);
  const pulse = 26 * (hit(t, F(28), 18) + hit(t, F(29), 18));
  const biteTop = keyed(t, 0, [
    { at: F(31) - 5, to: 800, s: { w: 40, z: 0.7 } },
    { at: F(31) + 3, to: 0, s: CARD },
    { at: F(31.5) - 5, to: 820, s: { w: 40, z: 0.7 } },
    { at: F(31.5) + 3, to: 0, s: CARD },
  ]);
  const biteBot = keyed(t, 0, [
    { at: F(31.5) - 5, to: -110, s: { w: 40, z: 0.7 } },
    { at: F(31.5) + 3, to: 0, s: CARD },
  ]);
  const blow = easeIn(span(t, F(32), F(32) + 14)) * 1400;
  const topY = inTop + pulse + biteTop - blow;
  const botY = -inTop - pulse + biteBot + blow;
  if (part === 'tongue') {
    g.fillStyle = TONGUE;
    g.beginPath();
    g.ellipse(540, 1760 + botY * 0.8, 700, 330, 0, 0, TAU);
    g.fill();
    g.strokeStyle = MAW;
    g.lineWidth = 10;
    g.beginPath();
    g.moveTo(540, 1520 + botY * 0.8);
    g.lineTo(540, 1920 + botY);
    g.stroke();
    return;
  }
  for (const [edge, dir] of [
    [topY, 1],
    [H + botY, -1],
  ] as const) {
    g.fillStyle = MAW_WALL;
    g.fillRect(-100, dir === 1 ? edge - 1400 : edge + 40, W + 200, 1400 + 20);
    g.fillStyle = TOOTH;
    const n = 7;
    for (let k = 0; k < n; k++) {
      const tw = (W + 120) / n;
      const x0 = -60 + k * tw;
      const len = (dir === 1 ? 210 : 170) * (0.8 + 0.35 * rnd(40 + (dir === 1 ? 0 : 1), k)) * (k === 1 || k === 5 ? 1.35 : 1);
      g.beginPath();
      g.moveTo(x0 + 6, edge + dir * 40);
      g.lineTo(x0 + tw - 6, edge + dir * 40);
      g.quadraticCurveTo(x0 + tw - 10, edge + dir * (40 + len * 0.7), x0 + tw / 2, edge + dir * (40 + len));
      g.quadraticCurveTo(x0 + 10, edge + dir * (40 + len * 0.7), x0 + 6, edge + dir * 40);
      g.fill();
    }
  }
}

/** Chips of tooth off each bite, arcing away under gravity. */
function drawChips(g: P, t: number): void {
  g.fillStyle = TOOTH;
  for (const [c, at] of [F(31), F(31.5)].entries()) {
    const d = t - at;
    if (d < 0 || d > 40) {
      continue;
    }
    for (let k = 0; k < 7; k++) {
      const vx = (rnd(50 + c, k) - 0.5) * 30;
      const vy = -8 - rnd(52 + c, k) * 14;
      const x = 540 + (rnd(54 + c, k) - 0.5) * 260 + vx * d;
      const y = BOX_REST - 165 + vy * d + 0.55 * d * d;
      g.save();
      g.translate(x, y);
      g.rotate(d * 0.3 * (k % 2 === 0 ? 1 : -1));
      g.beginPath();
      g.moveTo(-14, -10);
      g.lineTo(16, -6);
      g.lineTo(0, 16);
      g.closePath();
      g.fill();
      g.restore();
    }
  }
}

// ---------------------------------------------------------------------------
// Act four: the values, the plea, the flight (beats 32–48).

const BOX_X = 540;
const BOX_Y = 1080;

/** A thrown imp: held up on the Devil's horn this many frames before it strikes, released this many before. */
const IMP_HOLD = 30;
const IMP_FLIGHT = 16;

/** A hop of `height` pixels over `dur` frames from `at`: the arc's lift at `t`. */
function hopLift(t: number, at: number, dur: number, height: number): number {
  const u = (t - at) / dur;
  return u <= 0 || u >= 1 ? 0 : Math.sin(u * Math.PI) * height;
}

/** Every hop the Devil makes through the values: its start, length and height. */
const HOPS: readonly [number, number, number][] = [
  [F(32.75), 8, 30],
  [F(32.75) + 8, 7, 24],
  [F(33), 14, 170],
  [F(36), 12, 80],
  [F(36.5), 12, 60],
  [F(37), 12, 90],
  [F(38), 22, 240],
  [F(40), 12, 120],
  [F(40.5) + 4, 9, 28],
  [F(41), 9, 22],
  [F(43.5), 8, 40],
  [F(47) - 2, 14, 110],
];

/**
 * The Devil through the values: blown in, sneaking up on the lock, startled back,
 * throwing imps, greedy at the ad tags, blasted across the floor, reading the
 * code, then stepping toward the lens to beg, and fleeing as the dot.
 */
function fearDevil(t: number): DevilPose | null {
  if (t < F(32) + 6 || t >= F(47.5) + 24) {
    return null;
  }
  const enter = step(t - F(32) - 6, CARD);
  const flinch = impacts(t, 16);
  const shiver = (0.3 + 0.7 * clamp(span(t, F(42), F(47)))) * (1 + 2 * hit(t, F(46), 30));
  const tick = Math.floor(Math.round(t) / 2);
  const dot = step(t - F(47), SNAPPY);
  // the flight: a flattening wind-up on the half beat before, then one long arc out of frame left
  const flee = span(t, F(47.5), F(47.5) + 22);
  const fleeWind = clamp(span(t, F(47.5) - 7, F(47.5))) * (1 - clamp(span(t, F(47.5), F(47.5) + 3)));
  const lift = HOPS.reduce((sum, [at, dur, h]) => sum + hopLift(t, at, dur, h), 0);
  const landing = HOPS.reduce((sum, [at, dur, h]) => sum + hit(t, at + dur, 10) * Math.min(1, h / 120), 0);
  const x =
    keyed(t, 1400, [
      { at: F(32) + 6, to: 280, s: CARD },
      { at: F(32.75), to: 380, s: CARD },
      { at: F(33), to: 230, s: SNAPPY },
      { at: F(36), to: 330, s: CARD },
      { at: F(38), to: 150, s: { w: 10, z: 0.55 } },
      { at: F(40), to: 230, s: SNAPPY },
      { at: F(40.5), to: 370, s: CARD },
      { at: F(41.5), to: 300, s: SNAPPY },
      { at: F(42), to: 220, s: CARD },
      { at: F(42.5), to: 280, s: CARD },
      { at: F(43), to: 320, s: CARD },
      { at: F(44), to: 340, s: CAMERA },
    ]) +
    jitter(1, tick) * 3 * shiver -
    flee * 820 +
    30 * fleeWind;
  const y =
    keyed(t, 500, [
      { at: F(32) + 6, to: 1600, s: CARD },
      { at: F(36), to: 1450, s: CARD },
      { at: F(38), to: 1620, s: { w: 10, z: 0.55 } },
      { at: F(40), to: 1560, s: CARD },
      { at: F(44), to: 1570, s: CAMERA },
    ]) -
    lift +
    jitter(2, tick) * 3 * shiver -
    Math.sin(flee * Math.PI) * 520 +
    18 * fleeWind;
  const r = keyedLog(t, 150, [
    { at: F(40), to: 165, s: CARD },
    { at: F(44), to: 215, s: CAMERA },
    { at: F(47), to: 46, s: SNAPPY },
  ]);
  const rot =
    (1 - clamp(enter)) * TAU * 1.5 +
    keyed(t, 0, [
      { at: F(34) - IMP_HOLD, to: -0.4, s: CARD },
      { at: F(34) - IMP_FLIGHT, to: 0.45, s: SNAPPY },
      { at: F(34) + 4, to: -0.05, s: CARD },
      { at: F(35) - IMP_HOLD, to: -0.42, s: CARD },
      { at: F(35) - IMP_FLIGHT, to: 0.48, s: SNAPPY },
      { at: F(35) + 6, to: 0, s: CARD },
      { at: F(36), to: 0.12, s: PLAYFUL },
      { at: F(38), to: -TAU - 0.2, s: { w: 9, z: 0.6 } },
      { at: F(40), to: -TAU - 0.18, s: SNAPPY },
      { at: F(40.5), to: -TAU + 0.3, s: CARD },
      { at: F(41.5), to: -TAU - 0.22, s: SNAPPY },
      { at: F(42), to: -TAU - 0.48, s: CARD },
      { at: F(42.5), to: -TAU - 0.15, s: CARD },
      { at: F(43), to: -TAU + 0.12, s: CARD },
      { at: F(44), to: -TAU - 0.08, s: CAMERA },
    ]) +
    0.25 * Math.sin((t - F(43.5)) * 0.9) * hit(t, F(43.5), 20) -
    TAU * clamp(step(t - F(47), SNAPPY)) +
    (flee > 0 ? -1.2 * flee : 0) +
    0.06 * jitter(3, tick) * shiver;
  const mood = keyed(t, -1, [
    { at: F(32.5), to: 0.5, s: CARD },
    { at: F(33), to: -1, s: SNAPPY },
    { at: F(33) + 16, to: 0.35, s: CARD },
    { at: F(34), to: -1, s: SNAPPY },
    { at: F(34) + 8, to: 0.35, s: CARD },
    { at: F(35), to: -1, s: SNAPPY },
    { at: F(36), to: 1, s: PLAYFUL },
    { at: F(38), to: -1, s: SNAPPY },
    { at: F(40), to: -1, s: SNAPPY },
    { at: F(40.5), to: -0.25, s: CARD },
    { at: F(41.5), to: -1, s: SNAPPY },
    { at: F(42.5), to: -0.6, s: CARD },
    { at: F(43), to: -1, s: CARD },
  ]);
  // a different small reaction on each beat, so no beat repeats the last
  const k = beatIndex(t, 30);
  const beat = onBeats(t, 30, 0, 12);
  const kind = k % 4;
  // the code beat: startled by the flip, leans in to read, gasps, turns away, peeks with one eye, sags, shakes it off
  const reading = clamp(span(t, F(40.5), F(40.5) + 8)) * (1 - clamp(span(t, F(41.5) - 4, F(41.5))));
  const away = clamp(span(t, F(42) - 2, F(42) + 6)) * (1 - clamp(span(t, F(42.5), F(42.5) + 6)));
  const peek = clamp(span(t, F(42.5), F(42.5) + 6)) * (1 - clamp(span(t, F(43), F(43) + 6)));
  const sag = clamp(span(t, F(43), F(43) + 8)) * (1 - clamp(span(t, F(43.5), F(43.5) + 6)));
  const pleading = clamp(span(t, F(44), F(44) + 12));
  const greedy = clamp(span(t, F(36), F(36) + 6)) * (1 - clamp(span(t, F(38) - 2, F(38))));
  const lookX =
    lerp(lerp(0.85, 0.55, greedy) * (1 - reading) + Math.sin(t * 0.16) * 0.9 * reading, 0.5, pleading) -
    1.6 * away +
    0.2 * peek +
    (kind === 0 ? 0.5 * beat * (k % 8 === 0 ? 1 : -1) : 0);
  const lookY = lerp(lerp(-0.25, -0.9, greedy) * (1 - reading) + 0.5 * reading, -0.9, pleading) + 0.6 * sag;
  // each throw: a crouch while winding up, then a stretch on the release
  const crouch = [F(34), F(35)].reduce((sum, at) => sum + 0.12 * clamp(span(t, at - IMP_HOLD, at - IMP_HOLD + 6)) * (1 - clamp(span(t, at - IMP_FLIGHT, at - IMP_FLIGHT + 2))), 0);
  const release = [F(34), F(35)].reduce((sum, at) => sum + 0.16 * hit(t, at - IMP_FLIGHT, 12), 0);
  const squash =
    0.14 * flinch + 0.22 * landing + 0.2 * hit(t, F(46), 14) + (kind === 2 ? 0.07 * beat : 0) + crouch - release + 0.14 * sag + 0.18 * clamp(span(t, F(47) - 8, F(47))) * (1 - clamp(span(t, F(47), F(47) + 4))) + 0.4 * fleeWind - (flee > 0 && flee < 1 ? 0.3 : 0);
  const please = pleading * (0.2 + 0.35 * Math.max(0, Math.sin((t - F(44)) * 0.21)));
  return {
    ...REST,
    x,
    y,
    r,
    rot,
    sx: 1 + squash,
    sy: 1 - squash,
    mood,
    mouth: 0.12 + 0.9 * hit(t, F(41.5), 34) + 0.3 * sag + 0.3 * flinch + greedy * 0.25 + 0.45 * [F(36), F(36.5), F(37)].reduce((sum, at) => sum + hit(t, at, 14), 0) + please + 0.35 * hit(t, F(46), 20) + (kind === 2 ? 0.2 * beat : 0),
    lookX,
    lookY,
    lidL: blink(t, F(35.5)) + blink(t, F(39.2)) + blink(t, F(45.3)) + 0.45 * reading + 0.95 * away + 0.4 * sag,
    lidR: blink(t, F(35.5) + 10) + blink(t, F(39.2) + 11) + blink(t, F(45.3) + 10) + 0.3 * reading + 0.95 * clamp(span(t, F(42) + 6, F(42) + 12)) * (1 - clamp(span(t, F(43), F(43) + 6))) + 0.5 * sag,
    hornL: 1 - dot,
    hornR: 1 - dot,
    droopL:
      keyed(t, 0, [
        { at: F(38), to: 0.55, s: PLAYFUL },
        { at: F(40), to: 0.3, s: CARD },
        { at: F(44), to: 0.7, s: PLAYFUL },
      ]) +
      0.3 * (hit(t, F(41), 12) + hit(t, F(43), 12)) -
      0.45 * hit(t, F(41.5), 26) +
      0.5 * sag +
      (kind === 1 && k % 2 === 1 ? 0.25 * beat : 0),
    droopR:
      keyed(t, 0, [
        { at: F(38) + 3, to: 0.4, s: PLAYFUL },
        { at: F(40) + 5, to: 0.22, s: CARD },
        { at: F(44) + 4, to: 0.6, s: PLAYFUL },
      ]) +
      0.3 * hit(t, F(42), 12) -
      0.4 * hit(t, F(41.5) + 5, 26) +
      0.35 * sag +
      (kind === 1 && k % 2 === 0 ? 0.25 * beat : 0),
    features: 1 - clamp(dot * 1.3),
    sweat: clamp(span(t, F(33), F(36)) + (kind === 3 ? beat : 0)) * (1 - dot),
    t,
    grin: 1,
  };
}

function drawLockParts(g: P, t: number, ctx: Ctx, bx: number, by: number): void {
  const shackle = keyed(t, 0, [
    { at: F(33), to: 1, s: HEAVY, antic: 0.15 },
    { at: F(40), to: 0, s: SNAPPY },
  ]);
  if (shackle > 0.01) {
    g.save();
    g.translate(bx, by - BOX_SIZE / 2);
    g.strokeStyle = ctx.brand.brandRed;
    g.lineWidth = 46;
    g.lineCap = 'butt';
    const hgt = 190 * shackle;
    g.beginPath();
    g.moveTo(-88, 20);
    g.lineTo(-88, -hgt + 88);
    g.arc(0, -hgt + 88, 88, Math.PI, 0);
    g.lineTo(88, 20);
    g.stroke();
    g.restore();
  }
  const key = step(t - F(33) - 8, SNAPPY) * (1 - step(t - F(40), SNAPPY));
  if (key > 0.02) {
    g.save();
    g.translate(bx, by + 10);
    g.scale(key, key);
    g.fillStyle = PAPER;
    g.beginPath();
    g.arc(0, -18, 30, 0, TAU);
    g.fill();
    g.beginPath();
    g.moveTo(-16, -6);
    g.lineTo(16, -6);
    g.lineTo(24, 62);
    g.lineTo(-24, 62);
    g.closePath();
    g.fill();
    g.restore();
  }
}

/** The Devil's lock-picking imps: launched from him, they strike the lock and bounce away stunned. */
function drawImps(g: P, t: number, ctx: Ctx, bx: number, by: number): void {
  for (const [k, at] of [F(34), F(35)].entries()) {
    const d = t - (at - IMP_HOLD);
    if (d < 0 || d > IMP_HOLD + 44) {
      continue;
    }
    const tx = bx + (k === 0 ? -20 : 80);
    const ty = by - (k === 0 ? -10 : 170);
    let x: number;
    let y: number;
    let rot: number;
    let sx = 1;
    let sy = 1;
    // held up behind the horn while the Devil winds up, riding his lean
    const held = (when: number): [number, number, number] => {
      const dv = fearDevil(when);
      if (dv === null) {
        return [330, 1400, 0];
      }
      const ox = -0.35 * dv.r;
      const oy = -1.45 * dv.r;
      const c = Math.cos(dv.rot);
      const s2 = Math.sin(dv.rot);
      return [dv.x + ox * c - oy * s2, dv.y + ox * s2 + oy * c, dv.rot];
    };
    const release = at - IMP_FLIGHT;
    if (t < release) {
      [x, y, rot] = held(t);
      y -= 20 * Math.abs(Math.sin(t * 0.4));
    } else if (t < at) {
      const [hx, hy] = held(release);
      const u = (t - release) / IMP_FLIGHT;
      [x, y] = arcPoint(hx, hy, tx, ty, u, -260);
      rot = u * TAU * (k === 0 ? 1 : -1);
      sx = 1.25;
      sy = 0.8;
    } else {
      const e = t - at;
      const splat = hit(t, at, 6);
      x = tx - e * 11;
      y = ty - e * 9 + 0.45 * e * e;
      rot = e * 0.35;
      sx = 1 + 0.5 * splat;
      sy = 1 - 0.4 * splat;
    }
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.scale(0.8 * sx, 0.8 * sy);
    demon(g, { w: 130, h: 92, m: 1, flap: 0.6 * Math.sin(t * 0.7 + k), design: { ...PLAIN_DEMON, horn: 1.3, eyes: k, tail: 0.8 } });
    g.restore();
    // the zap
    const z = hit(t, at, 14);
    if (z > 0.05) {
      g.strokeStyle = ctx.brand.brandRed;
      g.lineWidth = 8 * z;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + k;
        g.beginPath();
        g.moveTo(tx + Math.cos(a) * 60, ty + Math.sin(a) * 60);
        g.lineTo(tx + Math.cos(a) * (60 + 70 * (1 - z) + 30), ty + Math.sin(a) * (60 + 70 * (1 - z) + 30));
        g.stroke();
      }
    }
  }
}

/** The Devil's ad tags, placed about the box where it hovers. */
const TAGS = [
  { x: -300, y: -160, label: 'AD', at: 36 },
  { x: 300, y: -120, label: '$', at: 36.5 },
  { x: 280, y: 330, label: 'AD', at: 37 },
];

function drawTags(g: P, t: number, ctx: Ctx, boxes: TextBox[]): void {
  const blast = F(38);
  const home = boxAt(F(37));
  for (const [k, spot] of TAGS.entries()) {
    const tag = { ...spot, x: home.x + spot.x, y: home.y + spot.y };
    const born = F(tag.at);
    if (t < born || t >= blast + 50) {
      continue;
    }
    const pop = step(t - born, PLAYFUL);
    const swing = 0.25 * Math.sin(t * 0.09 + k * 2) * clamp(pop);
    if (t < blast) {
      g.save();
      g.translate(tag.x, tag.y + 10 * wob(t, rnd(60, k), 2));
      g.rotate(swing - 0.2 + k * 0.15);
      g.scale(pop, pop);
      g.beginPath();
      g.moveTo(-70, -48);
      g.lineTo(70, -48);
      g.lineTo(110, 0);
      g.lineTo(70, 48);
      g.lineTo(-70, 48);
      g.closePath();
      g.fillStyle = BRIM;
      g.fill();
      g.beginPath();
      g.arc(78, 0, 11, 0, TAU);
      g.fillStyle = PAPER;
      g.fill();
      g.fillStyle = FEATURE;
      g.font = `800 58px ${ctx.fonts.sans ?? 'sans-serif'}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      if (!ctx.hideText) {
        g.fillText(tag.label, -12, 4);
      }
      g.restore();
      if (pop > 0.5) {
        boxes.push({
          id: `tag-${String(k)}`,
          text: tag.label,
          box: { x: tag.x - 60, y: tag.y - 30, width: 100, height: 60 },
          fontSizePx: 58,
          role: 'imagery',
        });
      }
    } else {
      // shattered: eight shards thrown off
      const d = t - blast;
      g.fillStyle = BRIM;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + rnd(61, k * 8 + i);
        const v = 14 + rnd(62, k * 8 + i) * 16;
        const x = tag.x + Math.cos(a) * v * d;
        const y = tag.y + Math.sin(a) * v * d + 0.6 * d * d;
        g.save();
        g.translate(x, y);
        g.rotate(d * 0.25 * (i % 2 === 0 ? 1 : -1));
        g.beginPath();
        g.moveTo(-26, -18);
        g.lineTo(28, -10);
        g.lineTo(-4, 26);
        g.closePath();
        g.fill();
        g.restore();
      }
    }
  }
  const ring = t - blast;
  if (ring >= 0 && ring < 30) {
    const at = boxAt(blast);
    drawRing(g, t, blast, at.x, at.y, 1500, ctx.brand.brandRed, 420);
  }
}

/** The code ribbon: printed down out of the box a step on each tick, lines of code on it, curling as it falls. */
function drawRibbon(g: P, t: number, bx: number, by: number): void {
  const len = keyed(t, 0, [
    { at: F(40) + 4, to: 260, s: SNAPPY },
    { at: F(41), to: 460, s: SNAPPY },
    { at: F(42), to: 640, s: SNAPPY },
    { at: F(43), to: 820, s: SNAPPY },
    { at: F(44) - 3, to: 0, s: SNAPPY },
  ]);
  if (len < 2) {
    return;
  }
  const scroll = keyed(t, 0, [
    { at: F(41), to: 90, s: SNAPPY },
    { at: F(42), to: 180, s: SNAPPY },
    { at: F(43), to: 270, s: SNAPPY },
  ]);
  const w = 270;
  const top = by + BOX_SIZE / 2 - 30;
  // the strip sways as it pays out: each row of it offset by a travelling wave
  const rowsN = Math.ceil(len / 24);
  const sway = (y: number): number => Math.sin((y - top) * 0.008 - t * 0.12) * 26 * clamp((y - top) / 300);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(bx - w / 2, top);
  for (let i = 0; i <= rowsN; i++) {
    const y = top + Math.min(len, i * 24);
    g.lineTo(bx - w / 2 + sway(y), y);
  }
  for (let i = rowsN; i >= 0; i--) {
    const y = top + Math.min(len, i * 24);
    g.lineTo(bx + w / 2 + sway(y), y);
  }
  g.closePath();
  g.fill();
  g.strokeStyle = '#d9d6cf';
  g.lineWidth = 3;
  g.stroke();
  for (let i = 0; i < 60; i++) {
    const y = top + 50 + i * 26 - scroll + 270;
    if (y < top + 40 || y > top + len - 16) {
      continue;
    }
    const indent = [0, 1, 2, 2, 1, 2, 3, 2, 1, 0][i % 10]! * 22;
    const lw = 50 + rnd(70, i) * 120 - indent * 0.5;
    const x0 = bx - w / 2 + 22 + indent + sway(y);
    g.fillStyle = i % 7 === 3 ? AI_BLUE : i % 5 === 1 ? '#9a978f' : PAPER_INK;
    rrect(g, x0, y, lw, 11, 5);
    g.fill();
    if (i % 3 === 0) {
      g.fillStyle = '#c9c6bf';
      rrect(g, x0 + lw + 8, y, 26 + rnd(71, i) * 40, 11, 5);
      g.fill();
    }
  }
}

// ---------------------------------------------------------------------------
// The reveal (beats 48–60).

const MARK_X = 540;

function markPlace(t: number): { y: number; size: number } {
  return {
    y: keyed(t, BOX_Y, [
      { at: F(48), to: 1000, s: HEAVY },
      { at: F(50) - 3, to: 455, s: CARD },
    ]),
    size: keyedLog(t, BOX_SIZE, [
      { at: F(48), to: 560, s: HEAVY },
      { at: F(50) - 3, to: 330, s: CARD },
    ]),
  };
}

/** Where the end card recomposes: a horizontal lockup as the tagline lands, the mark sinking huge under the words on the address, then the stacked lockup again. */
const L2 = F(52) - 4;
const L3 = F(55) - 4;
const L4 = F(57.5);

/** The end card's layout at `t`: the mark, the three lines and the dim echo of the mark, each on its own spring so they arrive apart. */
function endLayout(t: number): {
  markX: number;
  markY: number;
  size: number;
  nameX: number;
  nameTop: number;
  tagTop: number;
  urlTop: number;
  echoX: number;
  echoY: number;
  echoSize: number;
} {
  const place = markPlace(t);
  // each key carries its own lag, so lines moving up lead from the top and lines moving down lead from the bottom
  const move = (keys: readonly [number, number, number?][], s = CARD): number =>
    keyed(t, 0, keys.map(([at, to, lag]) => ({ at: at + (lag ?? 0), to, s })));
  // the lines travel on a near-critical spring: an overshoot would stack one line into the next
  const TYPE_MOVE = { w: 15, z: 0.88 };
  return {
    // between layouts the mark leaves by the side of the frame, so it never crosses the words
    markX: MARK_X + move([
      [L2, -280],
      [L3, -900],
      [L3 + 12, 0],
      [L4, 900],
      [L4 + 12, 0],
    ]),
    markY: place.y + move([
      [L2, 15],
      [L3 + 6, 1000],
      [L4 + 6, 0],
    ]),
    size:
      place.size *
      keyedLog(t, 1, [
        { at: L2, to: 250 / 330, s: CARD },
        { at: L3, to: 720 / 330, s: CARD },
        { at: L4, to: 1, s: CARD },
      ]),
    nameX: 540 + move([[L2, 115, 2], [L3, 0, 2], [L4, 0, 10]], TYPE_MOVE),
    nameTop: 650 + move([[L2, -240, 2], [L3, -330, 2], [L4, 0, 10]], TYPE_MOVE),
    tagTop: 800 + move([[L2, -160, 5], [L3, -330, 5], [L4, 0, 5]], TYPE_MOVE),
    urlTop: 1128 + move([[L2, -168, 8], [L3, -338, 8], [L4, 0, 0]], TYPE_MOVE),
    echoX: 540 + move([[L2, 330, 5], [L3, -250, 5], [L4, 0, 5]]),
    echoY: 1560 + move([[L2, -60, 5], [L3, -900, 5], [L4, 0, 5]]),
    echoSize: keyedLog(t, 1, [
      { at: L2 + 5, to: 0.8, s: CAMERA },
      { at: L3 + 5, to: 1.25, s: CAMERA },
      { at: L4 + 5, to: 1, s: CAMERA },
    ]),
  };
}

function drawReveal(g: P, t: number, ctx: Ctx): void {
  const flood = t >= F(48) - 1 ? 120 + expoOut(span(t, F(48) - 1, F(48) + 25)) * 1500 : 0;
  const lay = endLayout(t);
  const { markX, markY: y, size } = lay;
  g.beginPath();
  g.arc(MARK_X, BOX_Y, Math.max(0, flood), 0, TAU);
  g.fillStyle = ctx.brand.background;
  g.fill();
  // an echo of the mark, vast and dim, turning the other way behind the card; it sweeps on the address and swells on the push
  const echo = clamp(step(t - F(49), HEAVY));
  if (echo > 0.01) {
    const sweep = keyed(t, 0, [
      { at: F(55) - 2, to: Math.PI / 3, s: HEAVY },
      { at: F(57.5) - 2, to: Math.PI / 3 - 0.8, s: HEAVY },
    ]);
    g.save();
    g.translate(lay.echoX, lay.echoY);
    mark(g, {
      size: 1500 * echo * lay.echoSize,
      spin: 0.6 + (t - F(49)) * 0.0022 + sweep,
      a: Array.from({ length: 8 }, (_, i) => clamp(step(t - F(49) - i * 3, CARD))),
      dot: 0,
      color: '#262320',
    });
    g.restore();
  }
  // the brand's pulse: one thin ring out from the mark across the frame
  const ring = t - (F(58) - 1);
  if (ring >= 0 && ring < 44) {
    const u = easeOut(ring / 44);
    g.beginPath();
    g.arc(markX, y, size * 0.5 + 1500 * u, 0, TAU);
    g.lineWidth = 16 * (1 - u) + 2;
    g.strokeStyle = ctx.brand.brandRed;
    g.stroke();
  }
  const arcs = Array.from({ length: 8 }, (_, i) => clamp(step(t - F(48) - 2 - i * 2.5, HEAVY) * 1.02));
  // each tagline sentence changes the mark: one click for one interface, a flare for every feature, a clench for private
  const clicks = [52, 56, 59].reduce((sum, beat) => sum + (Math.PI / 4) * step(t - F(beat) + 2, HEAVY), 0);
  const flourish = TAU * step(t - F(57.5) + 2, { w: 9, z: 0.7 });
  const spin = keyed(t, Math.PI / 2, [{ at: F(48), to: 0, s: HEAVY }]) - (t - F(48)) * 0.0035 - clicks - flourish;
  const spread =
    1 +
    0.32 * hit(t, F(53), 20) -
    0.16 * hit(t, F(54), 24) +
    0.28 * hit(t, F(57.5), 26) +
    0.03 * Math.sin(t * 0.04);
  const squash = 1 + 0.12 * hit(t, F(52), 14);
  const shrink = 1 - clamp(span(t, F(48), F(48) + 8));
  if (shrink > 0) {
    g.save();
    g.translate(MARK_X, y);
    g.rotate(spin);
    drawBoxShape(g, ctx, BOX_SIZE * shrink);
    g.restore();
  }
  const pulse = 1 + (0.22 * onBeats(t, 30, 0, 14) + 0.5 * hit(t, F(54), 18) + 0.4 * hit(t, F(59), 18)) * clamp(span(t, F(50), F(51)));
  const breathe = arcs.map((a, i) => a * (1 + 0.035 * Math.sin(t * 0.05 + i * 1.3)));
  g.save();
  g.translate(markX, y);
  g.scale(squash, 2 - squash);
  mark(g, { size, spin, a: breathe, dot: step(t - F(48) - 1, PLAYFUL) * pulse, color: ctx.brand.brandRed, spread });
  g.restore();
}

// ---------------------------------------------------------------------------

/** A snap reframe: the camera whips to a new framing in about a quarter second and settles. */
const REFRAME = { w: 16, z: 0.75 };

/**
 * The camera over the values, the plea and the reveal. Each beat reframes:
 * punches on the lock, whips to the Devil winding up, follows each throw, pulls
 * wide for the tags, tilts down the code ribbon and back to the Devil's face.
 */
function valuesCam(t: number): Cam {
  return {
    cx: keyed(t, 540, [
      { at: F(32) + 1, to: 640, s: CAMERA },
      { at: F(32) + 10, to: 520, s: REFRAME },
      { at: F(33) - 2, to: 650, s: REFRAME },
      { at: F(33) + 14, to: 480, s: REFRAME },
      { at: F(34) - 2, to: 660, s: REFRAME },
      { at: F(34) + 8, to: 300, s: REFRAME },
      { at: F(35) - IMP_FLIGHT, to: 480, s: REFRAME },
      { at: F(35) - 2, to: 680, s: REFRAME },
      { at: F(36), to: 560, s: CARD },
      { at: F(37), to: 560, s: CAMERA },
      { at: F(38), to: 380, s: REFRAME },
      { at: F(40) - 2, to: 540, s: REFRAME },
      { at: F(40.5), to: 400, s: REFRAME },
      { at: F(41) - 2, to: 600, s: REFRAME },
      { at: F(41.5), to: 290, s: REFRAME },
      { at: F(42) - 2, to: 560, s: REFRAME },
      { at: F(42.5), to: 270, s: REFRAME },
      { at: F(43) - 2, to: 620, s: REFRAME },
      { at: F(43.5), to: 460, s: REFRAME },
      { at: F(44), to: 350, s: CAMERA },
      { at: F(46), to: 310, s: CAMERA },
      { at: F(47.5), to: 540, s: CARD },
      { at: F(50), to: 540, s: CAMERA },
    ]),
    cy: keyed(t, 960, [
      { at: F(32) + 1, to: 1180, s: CAMERA },
      { at: F(32) + 10, to: 1290, s: REFRAME },
      { at: F(33) - 2, to: 1300, s: REFRAME },
      { at: F(33) + 14, to: 1350, s: REFRAME },
      { at: F(34) - 2, to: 1300, s: REFRAME },
      { at: F(34) + 8, to: 1440, s: REFRAME },
      { at: F(35) - IMP_FLIGHT, to: 1330, s: REFRAME },
      { at: F(35) - 2, to: 1300, s: REFRAME },
      { at: F(36), to: 1150, s: CARD },
      { at: F(37), to: 1150, s: CAMERA },
      { at: F(38), to: 1200, s: REFRAME },
      { at: F(40) - 2, to: 1200, s: REFRAME },
      { at: F(40.5), to: 1420, s: REFRAME },
      { at: F(41) - 2, to: 1450, s: REFRAME },
      { at: F(41.5), to: 1470, s: REFRAME },
      { at: F(42) - 2, to: 1480, s: REFRAME },
      { at: F(42.5), to: 1450, s: REFRAME },
      { at: F(43) - 2, to: 1460, s: REFRAME },
      { at: F(43.5), to: 1460, s: REFRAME },
      { at: F(44), to: 1420, s: CAMERA },
      { at: F(46), to: 1420, s: CAMERA },
      { at: F(47.5), to: 960, s: CARD },
      { at: F(50), to: 960, s: CAMERA },
    ]),
    z: keyedLog(t, 1.0, [
      { at: F(32) + 1, to: 1.0, s: CAMERA },
      { at: F(32) + 10, to: 1.0, s: REFRAME },
      { at: F(33) - 2, to: 1.5, s: REFRAME },
      { at: F(33) + 14, to: 1.15, s: REFRAME },
      { at: F(34) - 2, to: 1.45, s: REFRAME },
      { at: F(34) + 8, to: 1.4, s: REFRAME },
      { at: F(35) - IMP_FLIGHT, to: 1.1, s: REFRAME },
      { at: F(35) - 2, to: 1.5, s: REFRAME },
      { at: F(36), to: 0.92, s: CARD },
      { at: F(37), to: 0.95, s: CAMERA },
      { at: F(38), to: 1.05, s: REFRAME },
      { at: F(40) - 2, to: 1.0, s: REFRAME },
      { at: F(40.5), to: 1.3, s: REFRAME },
      { at: F(41) - 2, to: 1.0, s: REFRAME },
      { at: F(41.5), to: 1.5, s: REFRAME },
      { at: F(42) - 2, to: 0.82, s: REFRAME },
      { at: F(42.5), to: 1.45, s: REFRAME },
      { at: F(43) - 2, to: 1.05, s: REFRAME },
      { at: F(43.5), to: 1.1, s: REFRAME },
      { at: F(44), to: 1.45, s: CAMERA },
      { at: F(46), to: 1.58, s: CAMERA },
      { at: F(47.5), to: 1.06, s: CARD },
      { at: F(50), to: 1.0, s: CAMERA },
    ]),
    rot: keyed(t, 0, [
      { at: F(32) + 1, to: -0.03, s: CAMERA },
      { at: F(32) + 10, to: 0.03, s: REFRAME },
      { at: F(33) - 2, to: 0.06, s: REFRAME },
      { at: F(33) + 14, to: 0.02, s: REFRAME },
      { at: F(34) - 2, to: -0.05, s: REFRAME },
      { at: F(34) + 8, to: 0.07, s: REFRAME },
      { at: F(35) - IMP_FLIGHT, to: -0.02, s: REFRAME },
      { at: F(35) - 2, to: 0.05, s: REFRAME },
      { at: F(36), to: 0.035, s: CARD },
      { at: F(37), to: -0.02, s: CAMERA },
      { at: F(38), to: 0.04, s: REFRAME },
      { at: F(40) - 2, to: 0.03, s: REFRAME },
      { at: F(40.5), to: -0.05, s: REFRAME },
      { at: F(41) - 2, to: -0.06, s: REFRAME },
      { at: F(41.5), to: 0.06, s: REFRAME },
      { at: F(42) - 2, to: -0.03, s: REFRAME },
      { at: F(42.5), to: -0.05, s: REFRAME },
      { at: F(43) - 2, to: 0.05, s: REFRAME },
      { at: F(43.5), to: 0.0, s: REFRAME },
      { at: F(44), to: 0.035, s: CAMERA },
      { at: F(46), to: -0.03, s: CAMERA },
      { at: F(47.5), to: 0.0, s: CARD },
      { at: F(50), to: 0.0, s: CAMERA },
    ]),
  };
}

/** Where the Devil stands when his dark spreads from him. */
const DEVIL_HOME: [number, number] = [330, 1470];

/** Where the Devil is at `t` during the plea: the spotlight closes on him. */
function pleaCentre(t: number): [number, number] {
  const d = fearDevil(Math.min(t, F(47.5)));
  return d === null ? DEVIL_HOME : [d.x, d.y];
}

/** How far the charcoal the flipped box pours out has spread, from the box. */
function charcoalRadius(t: number): number {
  return t < F(40) - 1 || t >= F(48) ? 0 : expoOut(span(t, F(40) - 1, F(40) + 16)) * 2800;
}

/** The plea's spotlight on the Devil: it opens on him, then bursts to fill the frame as he flees. */
function spotRadius(t: number): number {
  // it switches on around him a frame before the plea, already wider than his head, and opens out
  if (t < F(44) - 1) {
    return 0;
  }
  return keyed(t, 280, [
    { at: F(44) - 1, to: 440, s: CARD },
    { at: F(47.5), to: 2800, s: { w: 10, z: 0.9 } },
  ]);
}

/**
 * The value field's darkness at a world point: at the ad tags the Devil's ink
 * spreads from him until HushBox's shock ring wipes it back; from the code beat
 * the flipped box pours out warm charcoal, and at the plea a white spotlight
 * opens on the Devil inside it and bursts as he flees.
 */
function darkAt(t: number, x: number, y: number): boolean {
  if (t >= F(36) - 1 && t < F(38) + 30) {
    const spread = expoOut(span(t, F(36) - 1, F(36) + 12)) * 2600;
    const inDark = Math.hypot(x - DEVIL_HOME[0], y - DEVIL_HOME[1]) < spread;
    if (t < F(38)) {
      return inDark;
    }
    const at = boxAt(F(38));
    return inDark && Math.hypot(x - at.x, y - at.y) > wipeRadius(t);
  }
  const pour = boxAt(F(40));
  if (Math.hypot(x - pour.x, y - pour.y) < charcoalRadius(t)) {
    const [px, py] = pleaCentre(t);
    return Math.hypot(x - px, y - py) >= spotRadius(t);
  }
  return false;
}

/** The inner edge of the shock ring that wipes the dark away. */
function wipeRadius(t: number): number {
  const d = t - F(38);
  if (d < 0) {
    return 0;
  }
  const u = easeOut(d / 30);
  return Math.max(0, 30 + 1500 * u - (420 * (1 - u)) / 2);
}

function drawDark(g: P, t: number, ctx: Ctx): void {
  if (t >= F(36) - 1 && t < F(38) + 30) {
    const spread = expoOut(span(t, F(36) - 1, F(36) + 12)) * 2600;
    g.save();
    g.beginPath();
    g.arc(DEVIL_HOME[0], DEVIL_HOME[1], spread, 0, TAU);
    if (t >= F(38)) {
      const at = boxAt(F(38));
      g.arc(at.x, at.y, wipeRadius(t), 0, TAU, true);
    }
    g.fillStyle = INK;
    g.fill('evenodd');
    g.restore();
  }
  const pour = charcoalRadius(t);
  if (pour > 0) {
    const at = boxAt(F(40));
    g.beginPath();
    g.arc(at.x, at.y, pour, 0, TAU);
    g.fillStyle = ctx.brand.background;
    g.fill();
    const spot = spotRadius(t);
    if (spot > 0) {
      const [px, py] = pleaCentre(t);
      g.beginPath();
      g.arc(px, py, spot, 0, TAU);
      g.fillStyle = PAPER;
      g.fill();
    }
  }
}

/** Background and world for the frame, in order. */
function drawWorld(g: P, t: number, ctx: Ctx, boxes: TextBox[]): void {
  if (t < F(16)) {
    g.fillStyle = INK;
    g.fillRect(0, 0, W, H);
    g.save();
    applyCam(g, actOneCam(t), t);
    drawSpot(g, t);
    drawFloor(g, t);
    drawRing(g, t, 0, LAUNCH_X, FLOOR_Y, 420, BRIM, 10);
    drawSparks(g, t, 0, LAUNCH_X, FLOOR_Y);
    drawSparks(g, t, F(2), 540, FLOOR_Y);
    drawRing(g, t, F(2), 540, FLOOR_Y, 360, BRIM, 8);
    drawSclera(g, t);
    drawCards(g, t);
    drawSwarm(g, t);
    const dv = follow(actOneDevil, t);
    if (dv !== null) {
      g.save();
      if (t < F(4)) {
        g.beginPath();
        g.rect(-2000, -2000, 5000, 2000 + FLOOR_Y);
        g.clip();
      }
      drawDevil(g, dv, boilAt(t, 1));
      g.restore();
    }
    drawDot(g, t);
    drawCrack(g, t);
    g.restore();
    return;
  }
  if (t < F(28)) {
    g.fillStyle = PAPER;
    g.fillRect(0, 0, W, H);
    // the dark halves of the burst lid, still flying off at the drop
    const cam: Cam = {
      cx: 540,
      cy: keyed(t, 1060, [
        { at: F(16), to: 960, s: CARD },
        { at: F(16.5), to: 1260, s: CAMERA },
        { at: F(17.5) - 4, to: 1100, s: CARD },
        { at: F(20), to: 1000, s: CAMERA },
        { at: F(23), to: 960, s: CAMERA },
      ]),
      z: keyedLog(t, 1.85, [
        { at: F(16), to: 1, s: { w: 16, z: 0.75 } },
        { at: F(16.5), to: 1.5, s: CAMERA },
        { at: F(17.5) - 4, to: 0.88, s: CARD, antic: 0.05 },
        { at: F(20), to: 1.25, s: CAMERA },
        { at: F(23), to: 1, s: CAMERA },
        { at: F(24), to: 1.12, s: CAMERA },
        { at: F(25), to: 1.2, s: CAMERA },
        { at: F(27.5), to: 16, s: { w: 7, z: 1 } },
      ]),
      rot: keyed(t, 0, [
        { at: F(16.5), to: -0.08, s: CAMERA },
        { at: F(17.5) - 4, to: 0.05, s: CARD },
        { at: F(20), to: -0.06, s: CAMERA },
        { at: F(24), to: 0, s: CAMERA },
      ]),
    };
    if (t >= F(27.5)) {
      const p = giantPose(t);
      cam.cx = lerp(540, p.x, clamp(span(t, F(27.5), F(27.5) + 6)));
      cam.cy = lerp(960, p.y + p.r * 0.42, clamp(span(t, F(27.5), F(27.5) + 6)));
    }
    g.save();
    applyCam(g, cam, t);
    if (t < F(17)) {
      drawCrack(g, t);
      const gap = crackGap(t);
      g.fillStyle = INK;
      g.fillRect(-2000, -4000, 5000, 4000 + EYE_Y - gap / 2);
      g.fillRect(-2000, EYE_Y + gap / 2, 5000, 4000);
    }
    drawFlock(g, t);
    if (t >= F(24) - 4) {
      drawDevil(g, follow(giantPose, t)!, boilAt(t, 2));
    }
    g.restore();
    const h1 = drawHero(g, t, ctx, row('s1'), F(16), F(17.5), F(17), -1);
    const h2 = drawHero(g, t, ctx, row('s2'), F(20), F(23), F(21), 1);
    for (const b of [h1, h2]) {
      if (b !== null) {
        boxes.push(b);
      }
    }
    return;
  }
  if (t < F(32)) {
    g.fillStyle = MAW;
    g.fillRect(0, 0, W, H);
    // the white blast grows from the box under the teeth
    const b = boxAt(t);
    const blast = t >= F(32) - 1 ? 140 + expoOut(span(t, F(32) - 1, F(32) + 17)) * 1500 : 0;
    if (blast > 0) {
      g.beginPath();
      g.arc(b.x, b.y, blast, 0, TAU);
      g.fillStyle = PAPER;
      g.fill();
    }
    g.save();
    applyCam(g, { cx: 540, cy: 960, z: 1, rot: 0 }, t);
    drawMaw(g, t, 'tongue');
    drawRing(g, t, F(30), b.x, b.y + BOX_SIZE / 2, 500, TOOTH, 14);
    g.save();
    g.translate(b.x, b.y);
    g.rotate(b.rot);
    g.scale(b.sx, b.sy);
    drawBoxShape(g, ctx, BOX_SIZE);
    g.restore();
    drawMaw(g, t, 'teeth');
    drawChips(g, t);
    g.restore();
    return;
  }
  // values, plea, reveal: on the white field
  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, H);
  const cam = valuesCam(t);
  g.save();
  applyCam(g, cam, t);
  const b = boxAt(t);
  if (t < F(48)) {
    drawDark(g, t, ctx);
    const blastEdge = t < F(33) ? 140 + expoOut(span(t, F(32) - 1, F(32) + 17)) * 1500 : 99999;
    if (blastEdge < 1600) {
      // outside the blast the mouth is still there, blown open
      g.save();
      g.beginPath();
      g.rect(-2000, -2000, 5000, 6000);
      g.arc(b.x, b.y, blastEdge, 0, TAU, true);
      g.fillStyle = MAW;
      g.fill();
      g.restore();
    }
    const flip = t >= F(40) ? Math.cos(Math.PI * clamp(step(t - F(40), CARD))) : 1;
    drawLockParts(g, t, ctx, b.x, b.y);
    drawRibbon(g, t, b.x, b.y);
    g.save();
    g.translate(b.x, b.y);
    g.rotate(b.rot);
    g.scale(b.sx * (Math.abs(flip) < 0.05 ? 0.05 : Math.abs(flip)) , b.sy);
    drawBoxShape(g, ctx, BOX_SIZE);
    if (t >= F(40) + 8 && t < F(44) + 8) {
      // the box's back, a window of its own code
      g.fillStyle = mix('#ec4755', '#ffffff', 0.75);
      rrect(g, -BOX_SIZE * 0.36, -BOX_SIZE * 0.36, BOX_SIZE * 0.72, BOX_SIZE * 0.72, 30);
      g.fill();
      for (let i = 0; i < 6; i++) {
        g.fillStyle = ctx.brand.brandRed;
        rrect(g, -BOX_SIZE * 0.28 + (i % 3) * 16, -BOX_SIZE * 0.26 + i * 28, 70 + rnd(80, i) * 70, 12, 6);
        g.fill();
      }
    }
    g.restore();
    drawImps(g, t, ctx, b.x, b.y);
    drawTags(g, t, ctx, boxes);
    const dv = follow(fearDevil, t);
    if (dv !== null) {
      if (dv.features < 0.05 && t >= F(47)) {
        g.save();
        g.translate(dv.x, dv.y);
        g.rotate(dv.rot);
        g.scale(dv.sx, dv.sy);
        g.beginPath();
        g.arc(0, 0, dv.r, 0, TAU);
        g.fillStyle = BRIM;
        g.fill();
        g.restore();
      } else {
        drawDevil(g, dv, boilAt(t, 3));
      }
    }
  } else {
    drawReveal(g, t, ctx);
  }
  g.restore();
}

/** The type colour over the value field: white where the Devil's dark lies under a word, ink elsewhere. */
function fieldInk(t: number): (x: number, y: number) => string {
  const cam = valuesCam(t);
  return (x, y) => {
    const wx = (x - W / 2) / cam.z + cam.cx;
    const wy = (y - H / 2) / cam.z + cam.cy;
    return darkAt(t, wx, wy) ? PAPER : PAPER_INK;
  };
}

/** Each row's setting: where it sits, its size, its colour on the field behind it. */
function settingOf(r: Row, t: number, ctx: Ctx): Parameters<typeof drawRow>[2] {
  const base = { x: 96, top: 318, maxWidth: 780, size: 96, color: PAPER };
  switch (r.id) {
    case 't1':
      return { ...base, size: 100, stagger: 1 };
    case 't2':
    case 't3':
    case 't4':
      return { ...base, size: 100 };
    case 't5':
      return { ...base, size: 100, color: PAPER_INK };
    case 't6':
      return { ...base, size: 92, color: PAPER_INK };
    case 't7':
    case 't8':
      return { ...base, size: 150, top: 330, color: MAW_TYPE };
    case 'v1':
    case 'v2':
    case 'v3':
      return { ...base, size: 88, color: PAPER_INK, colorAt: fieldInk(t), tremble: 2 + 2 * clamp(span(t, F(32), F(44))), jitter };
    case 'p':
      return { ...base, size: 92, color: PAPER_INK, colorAt: fieldInk(t), tremble: 4, jitter };
    case 'wm':
      return { x: endLayout(t).nameX, top: endLayout(t).nameTop, maxWidth: 800, size: 116, color: ctx.brand.foreground, align: 'center' };
    case 'tag':
      return {
        x: 540,
        top: endLayout(t).tagTop,
        maxWidth: 640,
        size: 84,
        color: ctx.brand.foreground,
        align: 'center',
        lineHeight: 1.08,
        groups: [
          { words: 2, beat: 52 },
          { words: 2, beat: 53 },
          { words: 1, beat: 54 },
        ],
      };
    case 'url':
      return { x: 540, top: endLayout(t).urlTop, maxWidth: 800, size: 84, color: ctx.brand.muted, align: 'center' };
    default:
      return base;
  }
}

/** Reads the rows the host must see drawn at `frame`. */
function drawType(frame: number, t: number, ctx: Ctx, boxes: TextBox[]): void {
  for (const r of ROWS) {
    if (r.voice === 'secret') {
      continue;
    }
    const box = drawRow(frame, r, settingOf(r, t, ctx), ctx);
    if (box !== null) {
      boxes.push(box);
    }
  }
}

/**
 * The take draws on a 2D canvas. The look host loads it by path.
 * @toolContract
 */
export const context = '2d';

/**
 * Six sub-frames across a 180° shutter: the flights and whips smear as a camera would.
 * @toolContract
 */
export const motionBlur = 6;

/**
 * One continuous take: every picture is made out of the one before it.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  seeded(ctx);
  const g = ctx.context;
  const t = ctx.time;
  const boxes: TextBox[] = [];
  g.save();
  drawWorld(g, t, ctx, boxes);
  g.restore();
  drawGrain(g, frame);
  drawType(frame, t, ctx, boxes);
  return boxes;
};
