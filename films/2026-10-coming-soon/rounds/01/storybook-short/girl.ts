import { blob, ellipsePts, line, tube, wash } from './ink.js';
import { HER, TAU, clamp, hash, rgba, spring, wander } from './kit.js';

import type { Boil } from './ink.js';
import type { G, Pt } from './kit.js';

/**
 * Her pose: a hidden skeleton of angles. Limb angles are measured from straight
 * down, positive toward the way she faces; the near limbs are the ones toward
 * the camera.
 */
export interface Pose {
  x: number;
  y: number;
  scale: number;
  /** 1 faces right, -1 faces left. */
  facing: number;
  /** Lean of the spine from upright, positive toward her facing. */
  spine: number;
  /** The neck's bend from the spine. */
  neck: number;
  /** The head's tilt: positive drops the chin, negative lifts it. */
  head: number;
  /** 0 in profile, 1 seen from behind: the face fades as the hair turns to the camera. */
  back: number;
  armN: number;
  elbowN: number;
  armF: number;
  elbowF: number;
  legN: number;
  kneeN: number;
  legF: number;
  kneeF: number;
  /** -1 worried, 0 easy, 1 lifted. */
  brow: number;
  blink: number;
  /** -1 a frown, 0 a straight mouth, 1 a smile. */
  smile: number;
  /** The mouth open: 0 shut, 1 a round O. */
  open: number;
}

export type PoseKey = Partial<Pose>;
type Param = Exclude<keyof Pose, 'facing'>;

/** How many frames each part lags the body's key, so the head and hands follow through. */
const DELAY: Partial<Record<Param, number>> = {
  neck: 2,
  head: 5,
  armN: 1,
  elbowN: 4,
  armF: 4,
  elbowF: 8,
  kneeN: 2,
  kneeF: 3,
  brow: 3,
  smile: 4,
};

/** The figure's springs: a little loose, so every arrival overshoots and settles. */
const HZ = 2.5;
const DAMP = 6.5;

/**
 * The pose at `time` from a base pose and keys at frames: each change from one
 * key to the next is its own spring, so a value with many targets is their sum,
 * and each part runs its delay behind the body.
 */
export function posed(base: Pose, keys: readonly (readonly [number, PoseKey])[], time: number, hz = HZ, damp = DAMP): Pose {
  const out: Pose = { ...base };
  const params = Object.keys(base).filter((k) => k !== 'facing') as Param[];
  for (const p of params) {
    let prev = base[p];
    let value = base[p];
    const delay = DELAY[p] ?? 0;
    for (const [frame, key] of keys) {
      const next = key[p];
      if (next === undefined) {
        continue;
      }
      value += (next - prev) * spring(time - delay, frame, hz, damp);
      prev = next;
    }
    out[p] = value;
  }
  // Facing flips at its key's frame, never interpolated.
  for (const [frame, key] of keys) {
    if (key.facing !== undefined && time >= frame) {
      out.facing = key.facing;
    }
  }
  return out;
}

/**
 * The pose at `time` and the turn the bun, pencil and strand trail by, in the
 * head's own frame: they hang back where the head was a few frames ago while it
 * turns, then swing past it once it stops, and settle.
 */
export function posedLag(base: Pose, keys: readonly (readonly [number, PoseKey])[], time: number, seed: number, hz = HZ, damp = DAMP): { pose: Pose; lag: number } {
  const angle = (t: number): number => {
    const q = alive(posed(base, keys, t, hz, damp), t, seed);
    return q.spine + q.neck + q.head;
  };
  const now = alive(posed(base, keys, time, hz, damp), time, seed);
  const a0 = now.spine + now.neck + now.head;
  const a1 = angle(time - 7);
  const a2 = angle(time - 14);
  const lag = -0.8 * (a0 - a1) + 0.45 * (a1 - a2);
  return { pose: now, lag: Math.max(-0.85, Math.min(0.85, lag)) };
}

/** Breath and small drift, so a held pose is never frozen; each part on its own phase. */
export function alive(p: Pose, time: number, seed: number): Pose {
  const t = time / 60;
  return {
    ...p,
    spine: p.spine + 0.018 * Math.sin(t * 1.6 + seed),
    neck: p.neck + 0.03 * wander(t * 0.7, seed + 1),
    head: p.head + 0.025 * wander(t * 0.9, seed + 2),
    armF: p.armF + 0.03 * wander(t * 0.8, seed + 3),
    elbowN: p.elbowN + 0.02 * wander(t * 1.1, seed + 4),
    blink: Math.max(p.blink, blinkAt(time, seed)),
  };
}

/** A blink every two to four seconds, three frames shut. */
function blinkAt(time: number, seed: number): number {
  const period = 150 + Math.floor(hash(seed, 77) * 90);
  const phase = (time + hash(seed, 78) * period) % period;
  return phase < 4 ? 1 : 0;
}

const L = {
  torso: 150,
  neck: 30,
  head: 46,
  upper: 72,
  fore: 66,
  thigh: 92,
  shin: 88,
};

/** Her joints in world px, from the pose. */
export interface Joints {
  hip: Pt;
  neck: Pt;
  head: Pt;
  headAngle: number;
  shoulderN: Pt;
  shoulderF: Pt;
  elbowN: Pt;
  elbowF: Pt;
  wristN: Pt;
  wristF: Pt;
  handAngleN: number;
  handAngleF: number;
  kneeN: Pt;
  kneeF: Pt;
  ankleN: Pt;
  ankleF: Pt;
  shinN: number;
  shinF: number;
  up: Pt;
  fwd: Pt;
}

function dir(a: number, f: number): Pt {
  return [Math.sin(a) * f, Math.cos(a)];
}

function add(p: Pt, d: Pt, k: number): Pt {
  return [p[0] + d[0] * k, p[1] + d[1] * k];
}

/** Where a hand should reach, and which way its elbow bends: 1 out toward her facing, -1 back. */
export interface Reach {
  near?: Pt;
  far?: Pt;
  bendN?: number;
  bendF?: number;
}

/** A two-bone reach: the shoulder and elbow angles that put the wrist on the target, or as near as the arm allows. */
function solveArm(shoulder: Pt, target: Pt, l1: number, l2: number, f: number, bend: number): { arm: number; elbow: number } {
  const vx = target[0] - shoulder[0];
  const vy = target[1] - shoulder[1];
  const d = Math.min(Math.hypot(vx, vy), (l1 + l2) * 0.999);
  const aT = Math.atan2(vx * f, vy);
  const alpha = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * Math.max(d, 1e-6)))));
  const beta = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2))));
  return { arm: aT - bend * alpha, elbow: bend * (Math.PI - beta) };
}

export function joints(p: Pose, reach: Reach = {}): Joints {
  const f = p.facing;
  const s = p.scale;
  const up: Pt = [Math.sin(p.spine) * f, -Math.cos(p.spine)];
  const fwd: Pt = [Math.cos(p.spine) * f, Math.sin(p.spine)];
  const hip: Pt = [p.x, p.y];
  const neck = add(hip, up, L.torso * s);
  const headAngle = p.spine + p.neck;
  const head = add(neck, [Math.sin(headAngle) * f, -Math.cos(headAngle)], (L.neck + L.head * 0.85) * s);
  const shoulder = add(neck, up, -16 * s);
  const shoulderN = add(shoulder, fwd, 4 * s);
  const shoulderF = add(shoulder, fwd, -8 * s);
  const solvedN = reach.near === undefined ? null : solveArm(shoulderN, reach.near, L.upper * s, L.fore * s, f, reach.bendN ?? 1);
  const solvedF = reach.far === undefined ? null : solveArm(shoulderF, reach.far, L.upper * s, L.fore * s, f, reach.bendF ?? 1);
  const aN = solvedN === null ? p.spine + p.armN : solvedN.arm;
  const aF = solvedF === null ? p.spine + p.armF : solvedF.arm;
  const eN = solvedN === null ? p.elbowN : solvedN.elbow;
  const eF = solvedF === null ? p.elbowF : solvedF.elbow;
  const elbowN = add(shoulderN, dir(aN, f), L.upper * s);
  const elbowF = add(shoulderF, dir(aF, f), L.upper * s);
  const wristN = add(elbowN, dir(aN + eN, f), L.fore * s);
  const wristF = add(elbowF, dir(aF + eF, f), L.fore * s);
  const hipN = add(hip, fwd, 4 * s);
  const hipF = add(hip, fwd, -6 * s);
  const kneeN = add(hipN, dir(p.legN, f), L.thigh * s);
  const kneeF = add(hipF, dir(p.legF, f), L.thigh * s);
  const shinN = p.legN + p.kneeN;
  const shinF = p.legF + p.kneeF;
  const ankleN = add(kneeN, dir(shinN, f), L.shin * s);
  const ankleF = add(kneeF, dir(shinF, f), L.shin * s);
  return {
    hip,
    neck,
    head,
    headAngle: headAngle + p.head,
    shoulderN,
    shoulderF,
    elbowN,
    elbowF,
    wristN,
    wristF,
    handAngleN: aN + eN,
    handAngleF: aF + eF,
    kneeN,
    kneeF,
    ankleN,
    ankleF,
    shinN,
    shinF,
    up,
    fwd,
  };
}

/** Lines are drawn this wide at scale 1. */
const LW = 3.4;

function shoe(g: G, ankle: Pt, shin: number, f: number, s: number, ink: string, b: Boil): void {
  const fx = Math.cos(shin) * f;
  const fy = -Math.sin(shin);
  const toe: Pt = [ankle[0] + fx * 34 * s, ankle[1] + fy * 34 * s + 4 * s];
  const heel: Pt = [ankle[0] - fx * 8 * s, ankle[1] - fy * 8 * s + 6 * s];
  blob(g, [heel, [ankle[0], ankle[1] - 6 * s], toe, [toe[0] - fx * 4 * s, toe[1] + 9 * s], [heel[0], heel[1] + 9 * s]], '#2a2230', ink, LW * s * 0.8, b);
}

/** A mitten hand at the wrist, pointing along `angle`, the thumb on the facing side. */
function hand(g: G, wrist: Pt, angle: number, f: number, s: number, fill: string, ink: string, b: Boil): void {
  const d = dir(angle, f);
  const c = add(wrist, d, 12 * s);
  const n: Pt = [-d[1], d[0]];
  const pts: Pt[] = [
    add(add(wrist, n, 9 * s), d, 0),
    add(add(c, n, 11 * s), d, 6 * s),
    add(c, d, 16 * s),
    add(add(c, n, -11 * s), d, 6 * s),
    add(add(wrist, n, -9 * s), d, 0),
  ];
  blob(g, pts, fill, ink, LW * s * 0.85, b);
  // The thumb, a small bump off the side.
  const t0 = add(add(wrist, n, 9 * f * s), d, 6 * s);
  line(g, [t0, add(add(t0, n, 7 * f * s), d, 7 * s), add(add(t0, n, 3 * f * s), d, 13 * s)], LW * s * 0.75, ink, b);
}

interface DrawOptions {
  time: number;
  seed: number;
  /** The ink. */
  ink: string;
  /** 0 full colour, up to 1 sunk into the night's blue. */
  night: number;
  /** Something she holds in the near hand, drawn after it. */
  holding?: (g: G, j: Joints) => void;
  /** Drawn after the far arm and before the torso: what she holds behind herself. */
  behind?: (g: G, j: Joints) => void;
  /** Seen from behind: legs and arms go under the sweater, the head over it. */
  backView?: boolean;
  /** Targets her hands reach for. */
  reach?: Reach;
  /** How fast her head is turning, radians over the last few frames: the bun, pencil and strand trail it. */
  lag?: number;
  /** Hands drawn by something else (the close-up hands that hold the phone). */
  noHands?: boolean;
}

/** Fill colours sunk toward the night's blue by `night`. */
function tone(hex: string, night: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const gg = (n >> 8) & 255;
  const bb = n & 255;
  const k = 1 - 0.45 * night;
  const mixc = (v: number, t: number): number => Math.round(v * k + t * (1 - k));
  return `#${((mixc(r, 40) << 16) | (mixc(gg, 46) << 8) | mixc(bb, 96)).toString(16).padStart(6, '0')}`;
}

/** Her whole figure, line over the skeleton: legs, arms, sweater, head, bun and pencil. */
export function drawGirl(g: G, pose: Pose, o: DrawOptions): Joints {
  const j = joints(pose, o.reach);
  const s = pose.scale;
  const f = pose.facing;
  const b: Boil = { time: o.time, seed: o.seed, amp: 1.1 * s };
  const ink = o.ink;
  const lw = LW * s;
  const skin = tone(HER.skin, o.night);
  const sweater = tone(HER.sweater, o.night);
  const sweaterShade = tone(HER.sweaterShade, o.night);
  const trousers = tone(HER.trousers, o.night);
  const trousersShade = tone('#2f3d6c', o.night);
  const hair = tone(HER.hair, o.night);

  // Far limbs first, a shade darker.
  tube(g, [j.shoulderF, j.elbowF, j.wristF], 24 * s, sweaterShade, ink, lw, b);
  if (o.noHands !== true) {
    hand(g, j.wristF, j.handAngleF, f, s, tone(HER.skinShade, o.night), ink, b);
  }
  tube(g, [[j.hip[0] - j.fwd[0] * 6 * s, j.hip[1] - j.fwd[1] * 6 * s], j.kneeF, j.ankleF], 30 * s, trousersShade, ink, lw, b);
  shoe(g, j.ankleF, j.shinF, f, s, ink, b);
  o.behind?.(g, j);

  // The sweater: a soft, baggy shape along the spine, its hem below the hip.
  const at = (k: number, side: number): Pt => add(add(j.hip, j.up, k * s), j.fwd, side * s);
  const torso: Pt[] = [at(-16, -36), at(-18, 4), at(-14, 38), at(40, 38), at(92, 40), at(128, 30), at(146, 14), at(150, -8), at(140, -30), at(96, -40), at(40, -40)];
  blob(g, torso, sweater, ink, lw, b);
  // A cardigan's placket and a pocket: two strokes that show the turn of the body.
  line(g, [at(140, 18), at(90, 26), at(30, 26), at(-12, 24)], lw * 0.6, ink, b);
  line(g, [at(18, 8), at(18, 30)], lw * 0.5, ink, b);

  const nearLeg = (): void => {
    tube(g, [[j.hip[0] + j.fwd[0] * 4 * s, j.hip[1] + j.fwd[1] * 4 * s], j.kneeN, j.ankleN], 32 * s, trousers, ink, lw, b);
    shoe(g, j.ankleN, j.shinN, f, s, ink, b);
  };
  const nearArm = (): void => {
    tube(g, [j.shoulderN, j.elbowN, j.wristN], 25 * s, sweater, ink, lw, b);
    if (o.noHands !== true) {
      hand(g, j.wristN, j.handAngleN, f, s, skin, ink, b);
    }
    o.holding?.(g, j);
  };
  if (o.backView === true) {
    // Re-draw the sweater over the legs, then the arm she reaches with, then the back of her head.
    blob(g, torso, sweater, ink, lw, b);
    nearArm();
    drawHead(g, j, pose, { ...o, b, skin, hair, lw });
    return j;
  }
  nearLeg();
  drawHead(g, j, pose, { ...o, b, skin, hair, lw });
  // Near arm over everything.
  nearArm();
  return j;
}

interface HeadOptions extends DrawOptions {
  b: Boil;
  skin: string;
  hair: string;
  lw: number;
}

/** A point in the head's own frame: x toward her facing, y down, rotated with the head. */
function headPoint(j: Joints, f: number, s: number, x: number, y: number): Pt {
  const a = j.headAngle;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const lx = x * s * f;
  const ly = y * s;
  return [j.head[0] + lx * c - ly * sn * f, j.head[1] + lx * sn * f + ly * c];
}

function drawHead(g: G, j: Joints, p: Pose, o: HeadOptions): void {
  const s = p.scale;
  const f = p.facing;
  const hp = (x: number, y: number): Pt => headPoint(j, f, s, x, y);
  const { b, ink, lw } = o;
  // Neck.
  tube(g, [j.neck, hp(-6, 30)], 20 * s, o.skin, ink, lw * 0.9, b);
  // The bun and its pencil trail the head's turns: turned back by `lag` round the head's centre, the pencil further still.
  const lag = Math.max(-0.85, Math.min(0.85, o.lag ?? 0));
  const idle = 0.04 * Math.sin(o.time * 0.11 + o.seed);
  const turn = (x: number, y: number, px: number, py: number, a: number): Pt => {
    const dx = x - px;
    const dy = y - py;
    return [px + dx * Math.cos(a) - dy * Math.sin(a), py + dx * Math.sin(a) + dy * Math.cos(a)];
  };
  const [bunX, bunY] = turn(-30, -46, 0, 0, 0.9 * lag);
  const bun = hp(bunX, bunY);
  blob(g, ellipsePts(bun[0], bun[1], 25 * s, 23 * s, 12), o.hair, ink, lw, b);
  line(g, [hp(bunX - 16, bunY - 14), hp(bunX - 4, bunY - 4)], lw * 0.7, ink, b);
  const tilt = 1.6 * lag + idle;
  const pend = (dx: number, dy: number): Pt => {
    const [x, y] = turn(bunX + dx, bunY + dy, bunX, bunY, tilt);
    return hp(x, y);
  };
  const pa = pend(-34, -24);
  const pb = pend(28, 16);
  line(g, [pa, pb], 7 * s, ink, null);
  line(g, [pa, pb], 4.5 * s, HER.pencil, null);
  line(g, [pend(-34, -24), pend(-40, -28)], 5 * s, '#e9a6a0', null);
  // The face: a soft oval, a little longer than wide.
  const face: Pt[] = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * TAU;
    return hp(Math.cos(a) * 44 + (Math.cos(a) > 0 ? 3 : 0), Math.sin(a) * 48);
  });
  blob(g, face, o.skin, ink, lw, b);
  // Hair: a cap over the back and top, a fringe sweeping forward; from behind it covers the head.
  const cap: Pt[] = [hp(26, -36), hp(6, -50), hp(-24, -48), hp(-44, -26), hp(-46, 8), hp(-36, 34), hp(-22, 22), hp(-14, -6), hp(4, -22), hp(24, -22), hp(34, -28)];
  const capBack: Pt[] = face.map(([x, y]) => [x, y] as const);
  blob(g, p.back > 0.5 ? capBack : cap, o.hair, ink, lw, b);
  // A loose strand at the temple, swinging behind the head's moves.
  const sway = 0.12 * Math.sin(o.time * 0.09 + o.seed) + 1.4 * lag;
  const strand = (x: number, y: number): Pt => {
    const [tx, ty] = turn(x, y, 36, -36, sway);
    return hp(tx, ty);
  };
  line(g, [hp(36, -36), strand(44, -26), strand(42, -12)], lw * 0.8, ink, b);
  if (p.back < 0.6) {
    const show = clamp(1 - p.back / 0.6);
    g.save();
    g.globalAlpha = show;
    // Blush.
    const ch = hp(14, 18);
    g.fillStyle = rgba(HER.blush, 0.55);
    g.beginPath();
    g.ellipse(ch[0], ch[1], 10 * s, 7 * s, 0, 0, TAU);
    g.fill();
    // The eye: a dark oval with a catch-light, its upper lid drooping with worry; a curve when shut.
    const eye = hp(25, -2);
    if (p.blink > 0.5) {
      line(g, [hp(17, -1), hp(25, 3), hp(33, -1)], lw * 0.9, ink, null);
    } else {
      g.fillStyle = ink;
      g.beginPath();
      g.ellipse(eye[0], eye[1], 5.5 * s, 7 * s, 0, 0, TAU);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      const glint = hp(27, -5);
      g.arc(glint[0], glint[1], 1.8 * s, 0, TAU);
      g.fill();
      const droop = Math.max(0, -p.brow) * 5;
      line(g, [hp(18, -7 + droop * 0.4), hp(25, -10 + droop), hp(33, -7 + droop * 0.2)], lw * 0.8, ink, null);
    }
    // The brow: worry lifts its inner end and knits it; hope lifts it whole.
    const lift = -7 * Math.max(0, p.brow);
    const knit = p.brow < 0 ? -p.brow * 7 : 0;
    line(g, [hp(15, -19 + lift - knit), hp(26, -22 + lift), hp(35, -18 + lift + knit * 0.4)], lw * 0.95, ink, null);
    // The nose: a small hook on the profile.
    line(g, [hp(44, -4), hp(52, 6), hp(44, 10)], lw * 0.85, ink, b);
    // The mouth: a curve that turns up with a smile and down with worry; it opens round in surprise.
    const sm = p.smile * 6;
    if (p.open > 0.15) {
      const m = hp(36, 27);
      g.fillStyle = '#6b2c2a';
      g.strokeStyle = ink;
      g.lineWidth = lw * 0.8;
      g.beginPath();
      g.ellipse(m[0], m[1], (4 + 2 * p.open) * s, (3 + 5 * p.open) * s, j.headAngle * f, 0, TAU);
      g.fill();
      g.stroke();
    } else {
      line(g, [hp(28, 26 - sm * 0.1), hp(35, 27 + sm * 0.6), hp(42, 25 - sm)], lw * 0.95, ink, null);
    }
    g.restore();
  }
}

/** A small phone in her hand: dark, its screen glowing toward her. */
export function handPhone(g: G, j: Joints, near: boolean, s: number, glowColor: string, glowAlpha: number, b: Boil, ink: string): Pt {
  const w = near ? j.wristN : j.wristF;
  const a = near ? j.handAngleN : j.handAngleF;
  const d: Pt = [Math.sin(a), Math.cos(a)];
  const c: Pt = [w[0] + d[0] * 16 * s, w[1] + d[1] * 16 * s];
  g.save();
  g.translate(c[0], c[1]);
  g.rotate(-0.5);
  g.fillStyle = '#16131c';
  g.strokeStyle = ink;
  g.lineWidth = 2.5 * s;
  g.beginPath();
  g.roundRect(-14 * s, -24 * s, 28 * s, 48 * s, 5 * s);
  g.fill();
  g.stroke();
  g.fillStyle = rgba(glowColor, 0.85 * glowAlpha + 0.15);
  g.beginPath();
  g.roundRect(-11 * s, -21 * s, 22 * s, 42 * s, 3 * s);
  g.fill();
  g.restore();
  void b;
  return c;
}

/** The close-up hands that hold the phone: the left cups it, the right thumb types. */
export interface Hands {
  /** Where the right thumb's tip is, on the screen. */
  tip: Pt;
  /** 1 pressed flat on the glass, 0 lifted toward the camera. */
  press: number;
  /** The left index finger's tap, 0 to 1. */
  tap: number;
  /** A squeeze of the left hand on the Send. */
  grip: number;
  /** The thumb flattening against the glass on a hard press, 0 to 1. */
  squash?: number;
}

const THUMB_REST: Pt = [790, 1470];

/** The left hand behind the phone's left edge: heel, sleeve cuff, two fingertips curling round the edge. */
export function drawLeftHand(g: G, h: Hands, time: number, seed: number, ink: string): void {
  const b: Boil = { time, seed, amp: 1.6 };
  const sq = 6 * h.grip;
  // Sleeve cuff and the heel of the hand, from the bottom-left corner.
  blob(g, [[-60, 1960], [-40, 1700], [60, 1600], [150 + sq, 1560], [210, 1640], [230, 1960]], HER.skin, ink, 4, b);
  blob(g, [[-70, 1960], [-50, 1800], [130, 1780], [190, 1960]], HER.sweater, ink, 4, b);
  line(g, [[-30, 1850], [150, 1835]], 3, ink, b);
  // Two fingertips wrap the left edge from behind; the index taps.
  const tapX = -10 * h.tap;
  blob(g, ellipsePts(140 + tapX + sq, 1180, 26, 34, 12), HER.skin, ink, 4, b);
  blob(g, ellipsePts(136 + sq, 1270, 26, 34, 12), HER.skinShade, ink, 4, b);
}

/** The left thumb, resting along the phone's left bezel: drawn over the phone. */
export function drawLeftThumb(g: G, h: Hands, time: number, seed: number, ink: string): void {
  const b: Boil = { time, seed: seed + 3, amp: 1.6 };
  const sq = 4 * h.grip;
  tube(g, [[120, 1640], [168 + sq, 1520], [194 + sq, 1420]], 54, HER.skin, ink, 4, b);
  line(g, [[182 + sq, 1450], [196 + sq, 1426]], 3, ink, b);
}

/** The right hand: its heel and cuff behind the phone's right side, the thumb arcing over the glass to the tip. */
export function drawRightHand(g: G, h: Hands, time: number, seed: number, ink: string): void {
  const b: Boil = { time, seed: seed + 7, amp: 1.6 };
  const shift: Pt = [(h.tip[0] - THUMB_REST[0]) * 0.32, (h.tip[1] - THUMB_REST[1]) * 0.22];
  const lift = 1 - h.press;
  // The heel and cuff.
  blob(g, [[1140, 1960], [1130, 1640], [1000 + shift[0], 1560 + shift[1]], [905 + shift[0], 1600 + shift[1]], [860 + shift[0], 1960]], HER.skin, ink, 4, b);
  blob(g, [[1150, 1960], [1140, 1820], [930 + shift[0], 1800], [880 + shift[0], 1960]], HER.sweater, ink, 4, b);
  line(g, [[940 + shift[0], 1860], [1120, 1850]], 3, ink, b);
  // Fingertips behind the right edge.
  blob(g, ellipsePts(944, 1200 + shift[1] * 0.3, 24, 32, 12), HER.skinShade, ink, 4, b);
  blob(g, ellipsePts(948, 1290 + shift[1] * 0.3, 24, 32, 12), HER.skinShade, ink, 4, b);
  // The thumb: base, knuckle bowed outward, tip. Lifted, it looms a little nearer.
  const base: Pt = [960 + shift[0], 1640 + shift[1]];
  const sq = h.squash ?? 0;
  const tip: Pt = [h.tip[0] + lift * 6, h.tip[1] + lift * 10 + 10 * sq];
  const mid: Pt = [(base[0] + tip[0]) / 2 + 40 + 14 * sq, (base[1] + tip[1]) / 2 + 30 + 12 * sq];
  const width = 70 + 8 * lift + 22 * sq;
  if (lift > 0.05) {
    g.fillStyle = rgba('#000000', 0.25 * lift);
    g.beginPath();
    g.ellipse(tip[0] + 18 * lift, tip[1] + 24 * lift, 26, 18, -0.6, 0, TAU);
    g.fill();
  }
  tube(g, [base, mid, tip], width, HER.skin, ink, 4, b);
  // The nail, along the last joint.
  const dx = tip[0] - mid[0];
  const dy = tip[1] - mid[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nail: Pt[] = [
    [tip[0] - ux * 30 - uy * 12, tip[1] - uy * 30 + ux * 12],
    [tip[0] - ux * 6 - uy * 12, tip[1] - uy * 6 + ux * 12],
    [tip[0] - ux * 2, tip[1] - uy * 2],
    [tip[0] - ux * 6 + uy * 12, tip[1] - uy * 6 - ux * 12],
    [tip[0] - ux * 30 + uy * 12, tip[1] - uy * 30 - ux * 12],
  ];
  blob(g, nail, '#f7dcc4', ink, 2.5, b);
  // A knuckle crease.
  line(g, [[mid[0] - uy * 16, mid[1] + ux * 16], [mid[0] - uy * 4, mid[1] + ux * 4]], 3, ink, b);
  void wash;
}

export { THUMB_REST };
