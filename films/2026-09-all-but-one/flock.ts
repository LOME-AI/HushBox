// The leak's flock, brought across from round 1's one-take-launch take (its act-two leak) and
// redrawn in the film's gold line: secrets burst out as small chat bubbles that grow horns,
// wings, ember eyes and teeth, every demon built differently; three hero demons carry a secret
// each across the lens; the flock spirals in and lines up as the Devil's face.
import { CX, FPB, H, HELL, INK, W, bf, hash, mix, rgba } from './kit.js';
import { LEAKS, SWOOP_BEATS } from './score.js';
import { field } from './scenes-praise.js';
import { fontOf, frameBox } from './type.js';

import type { G } from './kit.js';
import type { LookContext, TextBox } from '../engine/look/index.js';

type Ctx = LookContext<'2d'>;
type Pt = [number, number];

const TAU = Math.PI * 2;
const FPS = 60;

// ---------------------------------------------------------------------------
// Closed-form motion: every value is a function of the instant alone.

/** A spring's natural frequency (rad/s) and damping ratio. */
interface Spring {
  w: number;
  z: number;
}

const CARD: Spring = { w: 19, z: 0.56 };
const CAMERA: Spring = { w: 9, z: 0.8 };

/** The unit step response of a spring released at frame 0, `frames` after it. */
function step(frames: number, s: Spring): number {
  if (frames <= 0) {
    return 0;
  }
  const t = frames / FPS;
  const wd = s.w * Math.sqrt(1 - s.z * s.z);
  const decay = Math.exp(-s.z * s.w * t);
  return 1 - decay * (Math.cos(wd * t) + ((s.z * s.w) / wd) * Math.sin(wd * t));
}

/** A small wind-up before a move: a dip of `depth` over `frames` before the start. */
function windup(framesToStart: number, depth: number, frames = 9): number {
  if (framesToStart <= 0 || framesToStart >= frames) {
    return 0;
  }
  const u = 1 - framesToStart / frames;
  return -depth * Math.sin(Math.PI * u) * u;
}

interface Key {
  at: number;
  to: number;
  s?: Spring;
  antic?: number;
}

/** A value with many targets: the sum of one spring per change. */
function keyed(frame: number, from: number, keys: readonly Key[]): number {
  let value = from;
  let previous = from;
  for (const key of keys) {
    const delta = key.to - previous;
    value += delta * step(frame - key.at, key.s ?? CARD);
    if (key.antic !== undefined) {
      value += delta * windup(key.at - frame, key.antic);
    }
    previous = key.to;
  }
  return value;
}

/** A keyed value in log space, for zoom. */
function keyedLog(frame: number, from: number, keys: readonly Key[]): number {
  return Math.exp(
    keyed(
      frame,
      Math.log(from),
      keys.map((k) => ({ ...k, to: Math.log(k.to) }))
    )
  );
}

function clamp(v: number, lo = 0, hi = 1): number {
  if (v < lo) {
    return lo;
  }
  if (v > hi) {
    return hi;
  }
  return v;
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

function span(frame: number, from: number, to: number): number {
  return clamp((frame - from) / (to - from));
}

function easeInOut(u: number): number {
  const c = clamp(u);
  return c * c * (3 - 2 * c);
}

function easeIn(u: number): number {
  const c = clamp(u);
  return c * c * c;
}

/** An impact envelope that ramps in over the frame and a half before `at`, so its own frame already shows it. */
function hit(frame: number, at: number, frames = 12): number {
  const d = frame - at;
  if (d < -1.5) {
    return 0;
  }
  if (d < 0) {
    const u = (d + 1.5) / 1.5;
    return u * u * (3 - 2 * u);
  }
  return Math.exp(-d / (frames / 3));
}

function onBeats(frame: number, every: number, frames = 12): number {
  const k = Math.floor(frame / every);
  return Math.max(hit(frame, k * every, frames), hit(frame, (k + 1) * every, frames));
}

function beatIndex(frame: number, every: number): number {
  return Math.floor((frame + 1.5) / every);
}

/** Two incommensurate sines with a seeded phase: idle breathing that never repeats in unison. */
function wob(t: number, phase: number, rate = 1): number {
  return (
    0.62 * Math.sin(t * 0.071 * rate + phase * 6.283) +
    0.38 * Math.sin(t * 0.1618 * rate + phase * 11.7 + 1.3)
  );
}

/** A seeded value in [0, 1) for element `i` of stream `k`. */
function rnd(k: number, index: number): number {
  return hash(index, k);
}

// ---------------------------------------------------------------------------
// The demon: a chat bubble that grows into a creature.

/** A chat bubble's outline as `n` points, centred at 0,0, its tail at the bottom left. */
function bubblePoints(w: number, h: number, n: number): Pt[] {
  const r = Math.min(w, h) * 0.32;
  const pts: Pt[] = [];
  const hw = w / 2;
  const hh = h / 2;
  for (let index = 0; index < n; index++) {
    const a = -Math.PI * 0.75 + (index / n) * TAU;
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
    const along = (x + hw) / w;
    if (y > hh * 0.98 && along > 0.12 && along < 0.38) {
      const v = 1 - Math.abs((along - 0.2) / 0.18);
      y += Math.max(0, v) ** 1.5 * h * 0.34;
      x -= Math.max(0, v) * w * 0.05;
    }
    pts.push([x, y]);
  }
  return pts;
}

function polygon(g: G, pts: readonly Pt[]): void {
  const [first] = pts;
  if (first === undefined) {
    return;
  }
  g.beginPath();
  g.moveTo(first[0], first[1]);
  for (const [x, y] of pts.slice(1)) {
    g.lineTo(x, y);
  }
  g.closePath();
}

/** How one demon is built, so no two in the flock are the same creature. */
interface DemonDesign {
  horn: number;
  curl: number;
  wing: number;
  scallops: number;
  /** 0: two slit eyes; 1: one big eye; 2: three small eyes. */
  eyes: number;
  teeth: number;
  tail: number;
}

const PLAIN_DEMON: DemonDesign = {
  horn: 1,
  curl: 0,
  wing: 1,
  scallops: 3,
  eyes: 0,
  teeth: 6,
  tail: 0,
};

/** The bubble the secret leaves as, and the shadow it grows into: the film's paper and near-black. */
const BUBBLE = '#ece6da';
const SHADOW = '#0a0705';
const TOOTH = '#fff3dc';

/** Fills the current path in the body colour and strokes it in gold, the film's line. */
function inked(g: G, body: string, line: string): void {
  g.fillStyle = body;
  g.fill();
  g.strokeStyle = line;
  g.stroke();
}

function wing(
  g: G,
  {
    side,
    flap,
    s,
    scallops,
    body,
    line,
  }: { side: number; flap: number; s: number; scallops: number; body: string; line: string }
): void {
  g.save();
  g.scale(side, 1);
  g.rotate(-flap);
  g.beginPath();
  g.moveTo(0, -0.1 * s);
  g.lineTo(0.55 * s, -0.55 * s);
  g.lineTo(1.05 * s, -0.25 * s);
  for (let index = 0; index < scallops; index++) {
    const x0 = 1.05 - (index / scallops) * 1.05;
    const x1 = 1.05 - ((index + 1) / scallops) * 1.05;
    g.quadraticCurveTo(
      ((x0 + x1) / 2) * s,
      (-0.12 + 0.1 * (index / scallops)) * s,
      x1 * s,
      (0.02 + 0.13 * ((index + 1) / scallops)) * s
    );
  }
  g.closePath();
  inked(g, body, line);
  g.restore();
}

/**
 * A secret turned demon: a chat bubble `w` by `h` that grows wings, horns, a tail, ember eyes
 * and teeth as `m` runs 0 to 1, its fill running from bubble paper to shadow under a gold line.
 * `px` is how many screen pixels one unit is, so the line keeps its width at any scale.
 */
function demon(
  g: G,
  o: {
    w: number;
    h: number;
    m: number;
    flap: number;
    flapR?: number;
    grin?: number;
    look?: number;
    design?: DemonDesign;
    px: number;
  }
): void {
  const { w, h, m, flap } = o;
  const design = o.design ?? PLAIN_DEMON;
  const ink = { body: mix(BUBBLE, SHADOW, m), line: rgba(INK.line, 0.35 + 0.65 * m) };
  g.lineWidth = 3 / Math.max(0.05, o.px);
  g.lineJoin = 'round';
  if (m > 0.02) {
    demonLimbs(g, { w, h, m, flap, flapR: o.flapR ?? flap * 0.86 + 0.08, design, ...ink });
  }
  polygon(g, bubblePoints(w, h, 40));
  inked(g, ink.body, ink.line);
  if (m > 0.3) {
    const e = clamp((m - 0.3) / 0.5);
    demonEyes(g, { w, h, e, look: o.look ?? 0, design });
    demonTeeth(g, { w, h, e, grin: o.grin ?? 1, design });
  }
}

interface Limbs {
  w: number;
  h: number;
  m: number;
  flap: number;
  flapR: number;
  design: DemonDesign;
  body: string;
  line: string;
}

/** A demon's wings, horns and tail, growing in with `m`. */
function demonLimbs(g: G, { w, h, m, flap, flapR, design, body, line }: Limbs): void {
  const s = h * 1.15 * design.wing * clamp(m * 1.4);
  g.save();
  g.translate(w * 0.38, -h * 0.05);
  wing(g, { side: 1, flap: flapR, s, scallops: design.scallops, body, line });
  g.restore();
  g.save();
  g.translate(-w * 0.38, -h * 0.05);
  wing(g, { side: -1, flap, s, scallops: design.scallops, body, line });
  g.restore();
  const hl = h * 0.42 * design.horn * clamp(m * 1.6 - 0.2);
  for (const side of [-1, 1]) {
    const bx = side * w * 0.28;
    const tip = side * h * (0.14 + 0.2 * design.curl);
    g.beginPath();
    g.moveTo(bx - h * 0.11, -h * 0.42);
    g.quadraticCurveTo(bx + side * h * 0.02, -h * 0.5 - hl * 0.6, bx + tip, -h * 0.46 - hl);
    g.quadraticCurveTo(bx + side * h * 0.04, -h * 0.5 - hl * 0.2, bx + h * 0.11, -h * 0.42);
    g.closePath();
    inked(g, body, line);
  }
  if (design.tail <= 0) {
    return;
  }
  const tl = h * design.tail * clamp(m * 1.5 - 0.3);
  const sway = Math.sin(flap * 2) * 0.3;
  g.save();
  g.lineWidth = h * 0.07;
  g.lineCap = 'round';
  g.strokeStyle = line;
  g.beginPath();
  g.moveTo(w * 0.2, h * 0.4);
  g.quadraticCurveTo(
    w * 0.4 + tl * 0.4,
    h * 0.5 + tl * (0.6 + sway),
    w * 0.3 + tl * 0.8,
    h * 0.3 + tl * 0.5
  );
  g.stroke();
  g.restore();
}

/** A demon's eyes as its design builds them: one big eye, two slits, or three. */
function demonEyes(
  g: G,
  { w, h, e, look, design }: { w: number; h: number; e: number; look: number; design: DemonDesign }
): void {
  g.fillStyle = INK.key;
  if (design.eyes === 1) {
    g.beginPath();
    g.ellipse(look * w * 0.05, -h * 0.13, h * 0.17 * e, h * 0.11 * e, 0, 0, TAU);
    g.fill();
    g.fillStyle = SHADOW;
    g.beginPath();
    g.ellipse(look * w * 0.09, -h * 0.13, h * 0.035 * e, h * 0.09 * e, 0, 0, TAU);
    g.fill();
    return;
  }
  const three = design.eyes === 2;
  const spots = three ? [-1, 0, 1] : [-1, 1];
  for (const side of spots) {
    g.save();
    g.translate(
      side * w * (three ? 0.14 : 0.18) + look * w * 0.04,
      -h * (side === 0 ? 0.24 : 0.12)
    );
    g.rotate(side * 0.35);
    g.beginPath();
    const k = three ? 0.7 : 1;
    g.ellipse(0, 0, h * 0.13 * e * k, h * 0.06 * e * k, 0, 0, TAU);
    g.fill();
    g.restore();
  }
}

/** A demon's row of teeth, wider and deeper with its grin. */
function demonTeeth(
  g: G,
  { w, h, e, grin, design }: { w: number; h: number; e: number; grin: number; design: DemonDesign }
): void {
  const tw = w * 0.5 * e * Math.min(grin, 1.6);
  if (tw <= 1) {
    return;
  }
  g.fillStyle = TOOTH;
  const n = Math.max(2, Math.round(design.teeth)) * 2 - 2;
  const bite = h * 0.12 * Math.max(1, grin);
  g.beginPath();
  for (let index = 0; index <= n; index++) {
    const x = -tw / 2 + (tw * index) / n;
    const y = h * 0.14 + (index % 2 === 0 ? 0 : bite) - Math.abs(x / tw) * h * 0.08;
    if (index === 0) {
      g.moveTo(x, y);
    } else {
      g.lineTo(x, y);
    }
  }
  g.lineTo(tw / 2, h * 0.06);
  g.lineTo(-tw / 2, h * 0.06);
  g.closePath();
  g.fill();
}

// ---------------------------------------------------------------------------
// The flock.

const FLOCK = 36;
/** The flock bursts out along the line where the Devil's eyes were open in the dark. */
export const SEAM_Y = 1190;
/** The face the flock lines up as: the laughing Devil's head in the next shot. */
const FACE_X = CX;
const FACE_Y = 1330;
const FACE_R = 330;

export const DROP = bf(24);
const CONVERGE = bf(30.75);
/** The beat the flock becomes the Devil's face. */
export const FACE_BEAT = 32;
const FACE = bf(FACE_BEAT);

/** The three heroes: each carries one secret across the lens, from `from` to `to`, lunging on its swoop. */
const HEROES = [
  { text: LEAKS[0], from: bf(24.25), to: bf(26.25), swoop: bf(SWOOP_BEATS[0]), side: -1 },
  { text: LEAKS[4], from: bf(26.5), to: bf(28.5), swoop: bf(SWOOP_BEATS[1]), side: 1 },
  { text: LEAKS[6], from: bf(28.75), to: bf(30.75), swoop: bf(SWOOP_BEATS[2]), side: -1 },
] as const;

/** Where flock demon `j` sits in the face the flock builds: outline, horns, then grin. */
function faceTarget(index: number): Pt {
  if (index < 22) {
    const a = (index / 22) * TAU - Math.PI / 2;
    const s = Math.sin(a);
    const chin = Math.max(0, s) ** 7 * 0.34;
    return [FACE_X + Math.cos(a) * 1 * FACE_R, FACE_Y + (s * 0.94 + chin) * FACE_R];
  }
  if (index < 30) {
    const side = index < 26 ? -1 : 1;
    const u = (((index - 22) % 4) + 1) / 4.3;
    const bx = side * 0.52;
    const by = -0.74;
    const tx = bx + Math.cos(-Math.PI / 2 + side * 0.3) * 1.2;
    const ty = by + Math.sin(-Math.PI / 2 + side * 0.3) * 1.2;
    const cx = bx + side * 0.4;
    const cy = by - 0.3;
    const v = 1 - u;
    return [
      FACE_X + (v * v * bx + 2 * v * u * cx + u * u * tx) * FACE_R,
      FACE_Y + (v * v * by + 2 * v * u * cy + u * u * ty) * FACE_R,
    ];
  }
  const x = -1 + (2 * (index - 30)) / 5;
  return [FACE_X + x * 0.5 * FACE_R, FACE_Y + (0.34 - 0.2 * x * x) * FACE_R];
}

function designOf(index: number): DemonDesign {
  return {
    horn: 0.5 + rnd(200, index) * 1.2,
    curl: rnd(201, index) * 2 - 1,
    wing: 0.7 + rnd(202, index) * 0.7,
    scallops: 2 + Math.floor(rnd(203, index) * 3),
    eyes: eyesOf(rnd(204, index)),
    teeth: 3 + Math.floor(rnd(205, index) * 5),
    tail: rnd(206, index) < 0.45 ? 0 : 0.5 + rnd(207, index) * 0.8,
  };
}

/** How many eyes a demon's seeded draw gives it: none, one or two. */
function eyesOf(draw: number): number {
  if (draw < 0.55) {
    return 0;
  }
  return draw < 0.8 ? 1 : 2;
}

/** Which way a seeded draw turns: -1 or 1. */
function turnOf(draw: number): number {
  return draw < 0.5 ? -1 : 1;
}

/** The reaction demon `j` gives on the beat: a seeded few chomp, snap their wings, spin or hop, a different few each beat. */
function beatReaction(
  index: number,
  t: number
): { grin: number; flap: number; spin: number; hop: number } {
  const k = beatIndex(t, FPB);
  const e = onBeats(t, FPB, 12);
  const r = rnd(300 + (k % 60), index);
  return {
    grin: r < 0.22 ? 1 + 0.9 * e : 1,
    flap: r >= 0.22 && r < 0.42 ? 0.9 * e : 0,
    spin: r >= 0.42 && r < 0.54 ? turnOf(rnd(301, index)) * 1.2 * e : 0,
    hop: r >= 0.54 && r < 0.66 ? 50 * e : 0,
  };
}

interface Member {
  x: number;
  y: number;
  s: number;
  rot: number;
  flap: number;
  flapR: number;
  m: number;
}

function flockAt(index: number, t: number): Member {
  const born = DROP + (index % 6);
  const sx = 70 + (index / FLOCK) * 940;
  // A shared drift kept small; each member wanders on its own rates, so the flock never shifts as a block.
  const cx =
    540 +
    60 * Math.sin(t * 0.021) +
    190 * Math.sin(t * (0.012 + 0.022 * rnd(50, index)) + rnd(51, index) * TAU);
  const cy =
    keyed(t, 1290, [
      { at: bf(26.5), to: 1060, s: CAMERA },
      { at: CONVERGE, to: FACE_Y, s: CAMERA },
    ]) +
    150 * Math.sin(t * (0.01 + 0.02 * rnd(52, index)) + rnd(53, index) * TAU);
  const rad =
    (200 + 320 * rnd(30, index)) *
    (1 + 0.25 * Math.sin(t * (0.015 + 0.03 * rnd(56, index)) + rnd(57, index) * TAU));
  const dir = rnd(31, index) < 0.3 ? -1 : 1;
  const a = rnd(32, index) * TAU + dir * t * (0.016 + 0.014 * rnd(33, index));
  const ox = cx + Math.cos(a) * rad;
  const oy = cy + Math.sin(a) * rad * 0.62 + Math.sin(a * 2 + rnd(38, index) * TAU) * 110;
  const out = step(t - born, CARD);
  // The burst: straight out from the seam, overshooting, then into orbit.
  const burstX = sx + (sx - 540) * 0.35 * hit(t, born, 30);
  const burstY = SEAM_Y + (rnd(34, index) - 0.5) * 900 * hit(t, born, 30);
  let x = lerp(burstX, ox, clamp(out));
  let y = lerp(burstY, oy, clamp(out));
  const conv = easeInOut(
    span(t, CONVERGE - 10 + rnd(54, index) * 16, FACE - 2 - rnd(55, index) * 6)
  );
  const [tx, ty] = faceTarget(index);
  if (conv > 0) {
    const ang = conv * Math.PI * (0.4 + 0.9 * rnd(58, index)) * (rnd(59, index) < 0.35 ? -1 : 1);
    const dx = x - tx;
    const dy = y - ty;
    const k = 1 - conv;
    x = tx + (dx * Math.cos(ang) - dy * Math.sin(ang)) * k;
    y = ty + (dx * Math.sin(ang) + dy * Math.cos(ang)) * k;
  }
  const depth = 0.7 + 0.75 * rnd(35, index);
  const mergeAt = FACE - 3 + rnd(60, index) * 10;
  const merge = 1 - clamp(span(t, mergeAt, mergeAt + 8));
  const beat = t * (0.25 + 0.35 * rnd(36, index)) + rnd(37, index) * TAU;
  return {
    x,
    y,
    s: lerp(0.25, depth, clamp(out)) * lerp(1, 0.6, conv) * merge,
    rot:
      ((rnd(39, index) - 0.5) * 0.8 + 0.25 * Math.sin(t * (0.03 + 0.04 * rnd(40, index)) + index)) *
      (1 - conv),
    flap: (0.3 + 0.5 * rnd(41, index)) * Math.sin(beat),
    flapR: (0.3 + 0.5 * rnd(42, index)) * Math.sin(beat + 0.3 + rnd(43, index) * 0.9),
    m: clamp(span(t, born, born + 14)),
  };
}

/** One flock demon drawn at its place, with its own build and its beat's reaction; `zoom` is the camera's scale. */
function drawMember(g: G, index: number, t: number, zoom: number): void {
  const d = flockAt(index, t);
  if (d.s <= 0.01) {
    return;
  }
  // Each banks into its own heading, read from where it was two frames back.
  const back = flockAt(index, t - 2);
  const bank = clamp((d.x - back.x) * 0.012, -0.5, 0.5);
  const react = beatReaction(index, t);
  g.save();
  g.translate(d.x, d.y - react.hop);
  g.rotate(d.rot + bank + react.spin);
  g.scale(d.s, d.s);
  demon(g, {
    w: 110 + 50 * rnd(44, index),
    h: 80 + 26 * rnd(45, index),
    m: d.m,
    flap: d.flap + react.flap,
    flapR: d.flapR + react.flap * 0.8,
    grin: react.grin,
    look: Math.sin(t * (0.02 + 0.03 * rnd(46, index)) + index),
    design: designOf(index),
    px: d.s * zoom,
  });
  g.restore();
}

/** The flock from the drop until it has merged into the face; the laugh shot draws its last frames. */
export function drawFlock(g: G, t: number, zoom = 1): void {
  if (t < DROP || t >= FACE + 16) {
    return;
  }
  for (let index = 0; index < FLOCK; index++) {
    drawMember(g, index, t, zoom);
  }
}

/** One demon crosses close to the lens, huge, between the first two heroes. */
function drawCrosser(g: G, t: number, zoom: number): void {
  const d = t - bf(26.25) + 10;
  if (d <= 0 || d >= 30) {
    return;
  }
  const u = d / 30;
  g.save();
  g.translate(lerp(1700, -700, easeInOut(u)), 1700 - 300 * Math.sin(u * Math.PI));
  g.rotate(-0.25 + u * 0.3);
  g.scale(6, 6);
  demon(g, {
    w: 130,
    h: 92,
    m: 1,
    flap: 0.6 * Math.sin(t * 0.3),
    design: { ...PLAIN_DEMON, horn: 1.5, curl: 0.6, eyes: 1, tail: 1 },
    px: 6 * zoom,
  });
  g.restore();
}

/** A hero demon carrying a secret written across its body, as imagery. */
function drawHero(
  g: G,
  ctx: Ctx,
  {
    time,
    hero,
    index,
    zoom,
  }: { time: number; hero: (typeof HEROES)[number]; index: number; zoom: number }
): TextBox | null {
  const { from, to, swoop, side } = hero;
  // Keyed to the whole frame, so both motion-blur samples draw the secret in one place and it never doubles.
  const t = Math.round(time);
  if (t < from || t >= to) {
    return null;
  }
  const enter = step(t - from + 2, { w: 22, z: 0.6 });
  const leave = easeIn(span(t, to - 10, to));
  // A smooth lunge, not an instant jump: the secret written on the body must stay sharp under motion blur.
  const ld = t - swoop + 3;
  const lunge = ld < 0 ? 0 : (1 - Math.exp(-ld / 4)) * Math.exp(-ld / 16) * 1.5;
  const sx = side < 0 ? 540 : 1500;
  const sy = side < 0 ? SEAM_Y : 700;
  const rx = 540;
  const ry = 820;
  const x =
    lerp(sx, rx, clamp(enter)) +
    (enter - clamp(enter)) * (rx - sx) +
    leave * -side * 1100 +
    18 * wob(t, 0.4 + index, 3);
  const y =
    lerp(sy, ry, clamp(enter)) +
    (enter - clamp(enter)) * (ry - sy) -
    leave * 500 +
    14 * wob(t, 0.8 + index, 2.6) +
    lunge * 30;
  const s = lerp(0.3, 1, clamp(enter)) * (1 + 0.16 * lunge) * (1 - leave * 0.4);
  const rot = -0.05 * side + 0.03 * Math.sin(t * 0.07) - lunge * 0.05 * side;
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.scale(s, s);
  demon(g, {
    w: 800,
    h: 280,
    m: clamp(span(t, from + 1, from + 8)),
    flap: 0.55 * Math.sin(t * 0.33),
    grin: 0,
    design: designOf(40 + index),
    px: s * zoom,
  });
  const size = 58;
  g.font = fontOf(ctx, 'sans', 700, size);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const words = hero.text.split(' ');
  const half = Math.ceil(words.length / 2);
  const lines = [words.slice(0, half).join(' '), words.slice(half).join(' ')];
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  const onFrame = g.getTransform();
  for (const [index_, line] of lines.entries()) {
    const baseline = 40 + index_ * 68;
    if (!ctx.hideText) {
      g.fillStyle = '#f2ece0';
      g.fillText(line, 0, baseline);
    }
    const m = g.measureText(line);
    left = Math.min(left, -m.actualBoundingBoxLeft);
    right = Math.max(right, m.actualBoundingBoxRight);
    top = Math.min(top, baseline - m.actualBoundingBoxAscent);
    bottom = Math.max(bottom, baseline + m.actualBoundingBoxDescent);
  }
  g.restore();
  // The box in frame pixels, through the demon's tilt and the flock's camera.
  return {
    id: `hero-${String(index)}`,
    text: hero.text,
    box: frameBox(onFrame, { x0: left, y0: top, x1: right, y1: bottom }),
    fontSizePx: size * Math.hypot(onFrame.a, onFrame.b),
    role: 'imagery',
  };
}

/** The flock shot's own camera: snaps back on the drop, dives in rolled, pulls wide, pushes on the second secret, settles for the face. */
function flockCam(t: number): { cy: number; z: number; rot: number } {
  return {
    cy: keyed(t, 1060, [
      { at: DROP, to: 960, s: CARD },
      { at: DROP + 12, to: 1150, s: CAMERA },
      { at: bf(26.5) - 4, to: 1000, s: CARD },
      { at: bf(28.75) - 4, to: 1060, s: CAMERA },
      { at: CONVERGE, to: H / 2, s: CAMERA },
    ]),
    z: keyedLog(t, 1.3, [
      { at: DROP, to: 1, s: { w: 16, z: 0.75 } },
      { at: DROP + 12, to: 1.35, s: CAMERA },
      { at: bf(26.5) - 4, to: 0.92, s: CARD, antic: 0.05 },
      { at: bf(28.75) - 4, to: 1.2, s: CAMERA },
      { at: CONVERGE, to: 1, s: CAMERA },
    ]),
    rot: keyed(t, 0, [
      { at: DROP + 12, to: -0.07, s: CAMERA },
      { at: bf(26.5) - 4, to: 0.05, s: CARD },
      { at: bf(28.75) - 4, to: -0.05, s: CAMERA },
      { at: CONVERGE, to: 0, s: CAMERA },
    ]),
  };
}

/**
 * Beats 24-32, the leak: a seam of light tears open where the Devil's eyes were, and the secrets
 * burst out as a flock of demons, each built differently; three heroes carry a secret each across
 * the lens, one demon crosses it huge, and the flock spirals in and lines up as his face.
 */
export function flock(g: G, ctx: Ctx, time: number): TextBox[] {
  field(g, { time, pal: HELL, glowY: 1300, glow: 0.7 });
  const cam = flockCam(time);
  g.save();
  g.translate(CX, H / 2);
  g.rotate(cam.rot);
  g.scale(cam.z, cam.z);
  g.translate(-CX, -cam.cy);
  // The seam: a white-hot line across the frame that tears open on the drop and fades as the flock pours out.
  const seam = hit(time, DROP, 18);
  if (seam > 0.01) {
    const hgt = 6 + 140 * (1 - seam);
    const glow = g.createLinearGradient(0, SEAM_Y - hgt, 0, SEAM_Y + hgt);
    glow.addColorStop(0, rgba(INK.key, 0));
    glow.addColorStop(0.5, rgba('#fff3d6', 0.85 * seam));
    glow.addColorStop(1, rgba(INK.key, 0));
    g.fillStyle = glow;
    g.fillRect(-400, SEAM_Y - hgt, W + 800, 2 * hgt);
  }
  drawFlock(g, time, cam.z);
  drawCrosser(g, time, cam.z);
  const boxes: TextBox[] = [];
  for (const [index, hero] of HEROES.entries()) {
    const box = drawHero(g, ctx, { time, hero, index, zoom: cam.z });
    if (box !== null) {
      boxes.push(box);
    }
  }
  g.restore();
  return boxes;
}

/** One of the flock's demons, by its seeded build, at a place and scale: the laugh's halo is made of them. */
export function haloDemon(
  g: G,
  {
    index,
    t,
    x,
    y,
    s,
    rot,
    zoom,
  }: { index: number; t: number; x: number; y: number; s: number; rot: number; zoom: number }
): void {
  if (s <= 0.01) {
    return;
  }
  const beat = t * (0.25 + 0.35 * rnd(36, index)) + rnd(37, index) * TAU;
  const react = beatReaction(index, t);
  g.save();
  g.translate(x, y - react.hop * s);
  g.rotate(rot + react.spin);
  g.scale(s, s);
  demon(g, {
    w: 110 + 50 * rnd(44, index),
    h: 80 + 26 * rnd(45, index),
    m: 1,
    flap: (0.3 + 0.5 * rnd(41, index)) * Math.sin(beat) + react.flap,
    flapR:
      (0.3 + 0.5 * rnd(42, index)) * Math.sin(beat + 0.3 + rnd(43, index) * 0.9) + react.flap * 0.8,
    grin: react.grin,
    look: Math.sin(t * (0.02 + 0.03 * rnd(46, index)) + index),
    design: designOf(index),
    px: s * zoom,
  });
  g.restore();
}
