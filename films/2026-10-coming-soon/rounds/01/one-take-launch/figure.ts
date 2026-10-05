import { FLOOR_Y, Z_HER, onLayer, visible } from './camera.js';
import { DEFAULT, INK, PLAYFUL, SNAPPY, TAU, bf, clamp, hash, lerp, mix, prog, rgba, roundRect, spring, springs, wander } from './kit.js';
import { BEAT } from './score.js';

import type { Cam } from './camera.js';
import type { G, Spring } from './kit.js';

/** Where she is, in the units of her layer: sitting on the floor just inside the doors, later standing there. */
export const HER_X = 400;

/** The slower, livelier spring her hair and sweater follow the same keys on: they arrive late and overshoot. */
const FOLLOW: Spring = { hz: 1.5, damp: 3.4 };

type Keys = readonly (readonly [number, number, Spring?])[];

/** A pose parameter: its rest value and its keys, each `[beat, target, spring?]`. */
interface Track {
  start: number;
  keys: Keys;
  s: Spring;
}

function at(beat: number, frames = 0): number {
  return bf(beat) + frames;
}

/**
 * Her acting, beat by beat. `stand` 0 sitting, 1 standing; `lean` towards the
 * phone (negative is a slump); `look` 0 down at the phone, 1 up and out; `turn`
 * her head over her shoulder to the seats; `smile`; `phoneUp` the phone raised
 * (1 above her head); `cheerL` the phone hand's fist pump on the cheer;
 * `hop` up off the floor; `twist` her body turning into each throw.
 */
const TRACKS = {
  stand: { start: 0, s: DEFAULT, keys: [[at(BEAT.stand, -2), 1]] },
  lean: {
    start: 0,
    s: DEFAULT,
    keys: [
      [at(BEAT.hover, -6), 1],
      [at(BEAT.withdraw, -2), -0.8],
      [at(5.5), -0.3],
      [at(BEAT.ask, -4), 0.2],
      [at(10), 0.7],
      [at(BEAT.send, -2), 1.1],
      [at(BEAT.send, 6), 0.1],
      [at(BEAT.react, -3), 1.2, SNAPPY],
      [at(15.75), 0.2],
      // The anticipation before she stands: a dip forward.
      [at(BEAT.stand, -9), 0.9, SNAPPY],
      [at(BEAT.stand, 2), 0],
      [at(BEAT.pick, -4), 0.8, SNAPPY],
      [at(BEAT.pick, 8), 0],
    ],
  },
  look: {
    start: 0,
    s: DEFAULT,
    keys: [
      [at(BEAT.withdraw, 2), 0.5],
      [at(5.5), 0],
      [at(BEAT.reply), 0.45],
      [at(BEAT.react, -3), 0.9, SNAPPY],
      [at(16), 0.4],
      [at(19.5), 0.25],
      [at(BEAT.sign, -4), 1],
      [at(BEAT.names[0], -6), 0.15],
      [at(BEAT.lit, -2), 1, SNAPPY],
      [at(BEAT.pages[0], -4), 0.8],
    ],
  },
  turn: { start: 0, s: DEFAULT, keys: [[at(BEAT.rows[1], 6), 1], [at(BEAT.stand, 20), 0]] },
  smile: { start: 0, s: DEFAULT, keys: [[at(BEAT.react, -3), 1, SNAPPY], [at(16), 0.6], [at(BEAT.lit, -2), 1]] },
  phoneUp: {
    start: 0,
    s: DEFAULT,
    keys: [
      [at(BEAT.pick, -6), 0.35, SNAPPY],
      [at(BEAT.pick, 10), 0],
      [at(BEAT.lit), -0.4],
      [at(BEAT.pages[0], -12), 1.05, SNAPPY],
      [at(BEAT.pages[3], 6), 0.6],
      [at(BEAT.note), 0],
    ],
  },
  cheerL: { start: 0, s: PLAYFUL, keys: [[at(BEAT.cheer, 5), 1], [at(BEAT.cheer, 13), 0.45], [at(BEAT.cheer, 20), 1]] },
  hop: { start: 0, s: PLAYFUL, keys: [[at(BEAT.cheer, -3), 1], [at(BEAT.cheer, 7), 0]] },
  /** Her body turning into each throw. */
  twist: {
    start: 0,
    s: SNAPPY,
    keys: BEAT.letters.flatMap((beat): (readonly [number, number])[] => [[at(beat, -41), -0.6], [at(beat, -35), 1], [at(beat, -30), 0]]),
  },
} satisfies Record<string, Track>;

type Pose = Record<keyof typeof TRACKS, number>;

function poseAt(time: number, follow: boolean): Pose {
  const out = {} as Pose;
  for (const [name, track] of Object.entries(TRACKS) as [keyof typeof TRACKS, Track][]) {
    out[name] = springs(time, track.start, track.keys, follow ? FOLLOW : track.s);
  }
  return out;
}

/** The skeleton a pose puts her in, in her layer's units. */
interface Body {
  hip: [number, number];
  shoulder: [number, number];
  head: [number, number];
  knees: [[number, number], [number, number]];
  feet: [[number, number], [number, number]];
  phone: [number, number];
}

function bodyOf(p: Pose, time: number): Body {
  const st = clamp(p.stand, 0, 1.08);
  const hopY = -16 * Math.max(0, p.hop);
  const breath = Math.sin((time / 60) * TAU * 0.28);
  const hipY = lerp(1490, 1408, st) + hopY;
  const shoulderY = hipY - lerp(86, 70, st) + breath * 0.8 + 2.5 * Math.max(0, p.lean) - 3 * Math.max(0, -p.lean);
  const shoulderX = HER_X + 4 * p.lean - 6 * p.twist;
  const head: [number, number] = [shoulderX + 3 * p.lean, shoulderY - 26 - 3 * p.look + 3 * Math.max(0, p.lean) + 4 * Math.max(0, -p.lean)];
  const knees: Body['knees'] = [
    [lerp(HER_X - 12, HER_X - 7, st), lerp(1446, 1456, st) + hopY * 0.6],
    [lerp(HER_X + 13, HER_X + 7, st), lerp(1448, 1456, st) + hopY * 0.6],
  ];
  const feet: Body['feet'] = [
    [lerp(HER_X - 16, HER_X - 9, st), FLOOR_Y - 4 + hopY * 0.4],
    [lerp(HER_X + 17, HER_X + 10, st), FLOOR_Y - 4 + hopY * 0.4],
  ];
  // The phone: in both hands on her knees sitting, at her chest standing; raised to tap and to send the pages.
  const rest: [number, number] = [lerp(HER_X + 1, HER_X + 4, st) + 0.5 * p.lean, lerp(1430, shoulderY + 44, st) - 0.6 * p.lean];
  const up = Math.max(0, p.phoneUp);
  const phone: [number, number] = [lerp(rest[0], HER_X + 30, Math.min(1, up)), lerp(rest[1], head[1] - 34, up) - 6 * Math.min(0, p.phoneUp)];
  return { hip: [HER_X, hipY], shoulder: [shoulderX, shoulderY], head, knees, feet, phone };
}

/** Where her phone is at a frame instant, on her layer: the pages fly from it. */
export function phoneAt(time: number): [number, number] {
  return bodyOf(poseAt(time, false), time).phone;
}

/** A blink: shut for four frames, at seeded moments. */
function blink(time: number): number {
  const period = 170;
  const phase = (time + 37) % period;
  const which = Math.floor((time + 37) / period);
  const when = 40 + hash(which, 21) * 90;
  return Math.abs(phase - when) < 3 ? 1 : 0;
}

function limb(g: G, pts: readonly [number, number][], width: number, color: string): void {
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  const [first, ...rest] = pts;
  if (first === undefined) {
    return;
  }
  g.moveTo(first[0], first[1]);
  if (rest.length === 2) {
    const [c, e] = rest as [[number, number], [number, number]];
    g.quadraticCurveTo(c[0], c[1], e[0], e[1]);
  } else {
    for (const q of rest) {
      g.lineTo(q[0], q[1]);
    }
  }
  g.stroke();
}

interface Face {
  tilt: number;
  look: number;
  turn: number;
  smile: number;
  glow: number;
  day: number;
  /** The bun's lag behind the head, in her layer's units. */
  lag: [number, number];
}

function head(g: G, x: number, y: number, f: Face, time: number): void {
  g.save();
  g.translate(x, y);
  g.rotate(f.tilt);
  // The bun trails the head and overshoots when she moves.
  const bx = -9 + f.lag[0] - 6 * f.turn;
  const by = -4 + f.lag[1];
  g.fillStyle = INK.hair;
  g.beginPath();
  g.arc(bx, by, 9, 0, TAU);
  g.fill();
  g.beginPath();
  g.arc(0, -1, 16.5, 0, TAU);
  g.fill();
  g.fillStyle = mix(INK.skin, '#c98e66', f.day * 0.4);
  g.beginPath();
  g.ellipse(0.5 + 2 * f.turn, 2, 13.2 - 2.5 * Math.abs(f.turn), 14.6, 0, 0, TAU);
  g.fill();
  // The fringe, swept to one side, swinging after the head.
  const sway = 0.6 * f.lag[0];
  g.fillStyle = INK.hair;
  g.beginPath();
  g.moveTo(-14 + 2 * f.turn, -1);
  g.quadraticCurveTo(-8 + sway, -18, 12 + 2 * f.turn, -12);
  g.quadraticCurveTo(15, -6, 13.5, -1 + 0.4 * sway);
  g.quadraticCurveTo(4 + sway, -9, -14 + 2 * f.turn, -1);
  g.fill();
  if (f.glow > 0) {
    const light = g.createRadialGradient(0, 14, 1, 0, 10, 18);
    light.addColorStop(0, rgba(INK.glow, 0.55 * f.glow));
    light.addColorStop(1, rgba(INK.glow, 0));
    g.fillStyle = light;
    g.beginPath();
    g.ellipse(0.5, 2, 13.2, 14.6, 0, 0, TAU);
    g.fill();
  }
  // Eyes: down at the phone (look 0) or up (look 1); turned, they slide towards the shoulder.
  const shut = blink(time);
  const ey = 3 + 1.5 * (1 - f.look);
  const ex0 = 5.5 * f.turn;
  g.strokeStyle = INK.hair;
  g.fillStyle = INK.hair;
  g.lineWidth = 1.6;
  g.lineCap = 'round';
  for (const [ex, far] of [[-5, f.turn > 0], [5.5, f.turn < 0]] as const) {
    const squeeze = far ? 1 - 0.6 * Math.abs(f.turn) : 1;
    if (shut === 1 || f.look < 0.35) {
      g.beginPath();
      g.ellipse(ex + ex0, ey - 0.5, 2.4 * squeeze, 2.4, 0, 0.15 * Math.PI, 0.85 * Math.PI);
      g.stroke();
    } else {
      g.beginPath();
      g.ellipse(ex + ex0, ey - 1.2 * f.look, 1.5 * squeeze, 2 + 0.3 * f.smile, 0, 0, TAU);
      g.fill();
    }
  }
  // Brows lift when she looks up and when she is delighted.
  const lift = 1.5 * f.look + 1.5 * f.smile;
  g.beginPath();
  g.moveTo(-8 + ex0, -3 - lift);
  g.lineTo(-2.5 + ex0, -3.6 - lift * 1.2);
  g.moveTo(3 + ex0, -3.6 - lift * 1.1);
  g.lineTo(8.5 + ex0, -3 - lift * 0.8);
  g.stroke();
  // The mouth: flat when unsure, a smile when delighted, open on the cheer.
  g.beginPath();
  g.moveTo(-3.5 + ex0, 10);
  g.quadraticCurveTo(0.5 + ex0, 10 + 3.2 * f.smile, 4.5 + ex0, 9.6 - 0.8 * f.smile);
  g.stroke();
  g.restore();
}

/** Where her free hand can go, each found from where her body is now. */
type HandTarget = 'phone' | 'thumb' | 'reach' | 'mouth' | 'hair' | 'chin' | 'chest' | 'fist' | 'hip' | 'point' | 'shade' | 'swipe' | 'scoop' | 'up' | 'out' | 'punch';

function handTarget(name: HandTarget, b: Body, time: number): [number, number] {
  const [px, py] = b.phone;
  const [hx, hy] = b.head;
  const [sx, sy] = b.shoulder;
  const [ix, iy] = b.hip;
  switch (name) {
    case 'phone':
      return [px - 8, py + 8];
    case 'thumb':
      return [px - 3, py - 4];
    case 'reach':
      return [px + 2, py - 15];
    case 'mouth':
      return [hx - 2, hy + 12];
    case 'hair':
      return [hx - 13, hy - 11];
    case 'chin':
      return [hx + 1, hy + 17];
    case 'chest':
      return [sx - 5, sy + 22];
    case 'fist':
      return [sx - 30, sy - 28];
    case 'hip':
      return [ix - 22, iy - 4];
    case 'point':
      return [sx - 46, sy + 30];
    case 'shade':
      return [hx - 4, hy - 13];
    case 'swipe':
      return [px - 3 + 7 * Math.sin((TAU * time) / 24), py - 6];
    case 'scoop':
      return [ix + 16, iy + 10];
    case 'up':
      return [sx - 40, sy - 52];
    case 'out':
      return [sx - 62, sy + 4];
    case 'punch':
      return [sx - 22, sy - 60];
  }
}

/** Her free hand's beats: `[frame, target, spring?]`, a new action on every beat of hers, in frame order. */
type HandKey = readonly [number, HandTarget, Spring?];

const HAND: readonly HandKey[] = ([
  [0, 'thumb'],
  [at(BEAT.hover, -8), 'reach'],
  [at(BEAT.withdraw, -4), 'mouth'],
  [at(BEAT.pops[0], -4), 'thumb'],
  [at(BEAT.pops[4], 6), 'hair', DEFAULT],
  [at(BEAT.ask, 4), 'thumb'],
  [at(BEAT.send, -10), 'reach'],
  [at(BEAT.send, -3), 'thumb'],
  [at(BEAT.send, 14), 'chin', DEFAULT],
  [at(BEAT.run, -5), 'thumb'],
  [at(14.25), 'chest', DEFAULT],
  [at(BEAT.react, -4), 'fist', PLAYFUL],
  [at(16), 'phone', DEFAULT],
  [at(BEAT.stand, 4), 'hip', DEFAULT],
  [at(BEAT.chips[0], -8), 'point'],
  [at(BEAT.road, 8), 'phone', DEFAULT],
  [at(BEAT.sign, -10), 'shade'],
  [at(BEAT.bulbs, 6), 'phone', DEFAULT],
  [at(BEAT.names[0], -4), 'swipe', DEFAULT],
  [at(BEAT.pick, -5), 'thumb'],
  [at(BEAT.pick, 8), 'chest', DEFAULT],
  [at(BEAT.pages[0], -12), 'hip', DEFAULT],
  [at(BEAT.dawn, 2), 'shade'],
  [at(BEAT.peels[1], 4), 'chin', DEFAULT],
  // Each letter of OPEN, one sweep a half beat: the wind-up scoops low across her towards the pile, the release flings high
  // towards the board as the letter leaves, the follow-through carries the arm out wide, into the next scoop.
  ...BEAT.letters.flatMap((beat): HandKey[] => [
    [at(beat, -41), 'scoop'],
    [at(beat, -35), 'up'],
    [at(beat, -30), 'out'],
  ]),
  [at(BEAT.inhale), 'hip', DEFAULT],
  [at(BEAT.cheer, -3), 'punch', PLAYFUL],
] satisfies HandKey[]).sort((a, b) => a[0] - b[0]);

/** Whether a thumb is busy on the screen: typing, deleting or scrolling, as a small quick bob. */
function thumbBob(time: number): number {
  const windows: [number, number][] = [
    [at(BEAT.type), at(2.75)],
    [at(BEAT.pops[0], -4), at(BEAT.pops[4], 4)],
    [at(BEAT.ask), at(9.6)],
  ];
  for (const [a, b] of windows) {
    if (time >= a && time < b) {
      return 2.6 * (1 - Math.cos((TAU * (time - a)) / 5)) / 2;
    }
  }
  return 0;
}

/** Her free hand: one spring per change of target, each target found from her body as it is now. */
function freeHand(time: number, b: Body): [number, number] {
  const first = HAND[0];
  if (first === undefined) {
    return b.phone;
  }
  let [x, y] = handTarget(first[1], b, time);
  let prev = [x, y];
  for (let i = 1; i < HAND.length; i++) {
    const key = HAND[i];
    if (key === undefined) {
      continue;
    }
    const target = handTarget(key[1], b, time);
    const w = spring(time, key[0], key[2] ?? SNAPPY);
    x += (target[0] - (prev[0] ?? 0)) * w;
    y += (target[1] - (prev[1] ?? 0)) * w;
    prev = target;
  }
  return [x, y + thumbBob(time)];
}

/** The hand pulled in to within an arm's length of its shoulder. */
function reach(shoulder: [number, number], hand: [number, number]): [number, number] {
  const dx = hand[0] - shoulder[0];
  const dy = hand[1] - shoulder[1];
  const d = Math.hypot(dx, dy);
  const most = 64;
  return d <= most ? hand : [shoulder[0] + (dx * most) / d, shoulder[1] + (dy * most) / d];
}

/** An elbow for an arm from shoulder to hand: bent outward on its side, more as the hand comes in. */
function elbow(shoulder: [number, number], hand: [number, number], side: -1 | 1): [number, number] {
  const mx = (shoulder[0] + hand[0]) / 2;
  const my = (shoulder[1] + hand[1]) / 2;
  const dx = hand[0] - shoulder[0];
  const dy = hand[1] - shoulder[1];
  const d = Math.hypot(dx, dy) || 1;
  const bend = Math.sqrt(Math.max(0, 33 * 33 - (d / 2) * (d / 2)));
  // Perpendicular to the arm, towards her side.
  let nx = -dy / d;
  let ny = dx / d;
  if (nx * side < 0) {
    nx = -nx;
    ny = -ny;
  }
  return [mx + nx * bend, my + ny * bend];
}

/**
 * Her: sitting on the floor just inside the doors with her phone, then
 * standing there as the seats land, acting each beat of the build. Her hair
 * and the hem of her sweater follow every move late, on a looser spring.
 */
export function drawHer(g: G, cam: Cam, time: number): void {
  if (!visible(cam, Z_HER)) {
    return;
  }
  onLayer(g, cam, Z_HER);
  const p = poseAt(time, false);
  const q = poseAt(time, true);
  const b = bodyOf(p, time);
  const lagged = bodyOf(q, time);
  const day = 1 - clamp(1 - prog(time, bf(BEAT.dawn), bf(BEAT.dawn + 5)));
  const st = clamp(p.stand, 0, 1.08);
  const glow = 1 - clamp(p.phoneUp) * 0.6 - day;
  const skin = mix(INK.skin, '#c98e66', day * 0.4);
  // The lag of her hair and hem: where the looser spring has them, less where the body is.
  const lag: [number, number] = [clamp((lagged.head[0] - b.head[0]) * 1.6, -9, 9), clamp((lagged.head[1] - b.head[1]) * 1.2, -8, 8)];
  const hem = clamp((lagged.hip[1] - b.hip[1]) * 0.5 + (lagged.shoulder[0] - b.shoulder[0]) * 0.8, -7, 7);
  const [hx, hy] = b.hip;
  const [sx, sy] = b.shoulder;
  const legs = (): void => {
    // Thighs up to raised knees when sitting, straight down when standing; shoes on the floor.
    for (const i of [0, 1] as const) {
      const knee = b.knees[i];
      const foot = b.feet[i];
      limb(g, [[hx + (i === 0 ? -8 : 8), hy - 2], knee, foot], lerp(19, 12, st), INK.trousers);
      g.fillStyle = '#1b1820';
      roundRect(g, foot[0] - (i === 0 ? 15 : 3), foot[1] - 5, 18, 9, 4);
      g.fill();
    }
    if (st < 0.5) {
      // Sitting, the shins stand as one block from the knees to the floor.
      const r = lerp(13, 8, st * 2);
      const [k0, k1] = b.knees;
      g.fillStyle = INK.trousers;
      g.fillRect(k0[0] - r, Math.min(k0[1], k1[1]), k1[0] - k0[0] + 2 * r, FLOOR_Y - 6 - Math.min(k0[1], k1[1]));
      for (const knee of b.knees) {
        g.beginPath();
        g.arc(knee[0], knee[1], r, 0, TAU);
        g.fill();
      }
      g.fillStyle = '#1b1820';
      roundRect(g, k0[0] - r - 4, FLOOR_Y - 9, 26, 9, 4);
      g.fill();
      roundRect(g, k1[0] + r - 22, FLOOR_Y - 9, 26, 9, 4);
      g.fill();
    }
  };
  // Standing, her legs are below the sweater; sitting, her knees come up in front of it.
  if (st >= 0.5) {
    legs();
  }
  // The torso: a sweater, its hem swinging after the body.
  g.fillStyle = INK.sweater;
  g.beginPath();
  g.moveTo(sx - 21, sy + 5);
  g.quadraticCurveTo(sx - 23, sy - 4, sx - 11, sy - 6);
  g.lineTo(sx + 11, sy - 6);
  g.quadraticCurveTo(sx + 23, sy - 4, sx + 21, sy + 5);
  g.lineTo(hx + 18 + hem, hy + 4);
  g.quadraticCurveTo(hx + hem * 0.5, hy + 9 + Math.abs(hem) * 0.4, hx - 18 + hem, hy + 4);
  g.closePath();
  g.fill();
  g.fillStyle = INK.sweaterShade;
  g.beginPath();
  g.moveTo(hx - 18 + hem, hy - 10);
  g.lineTo(hx + 18 + hem, hy - 10);
  g.lineTo(hx + 18 + hem, hy + 4);
  g.quadraticCurveTo(hx + hem * 0.5, hy + 9, hx - 18 + hem, hy + 4);
  g.closePath();
  g.fill();
  if (st < 0.5) {
    legs();
  }
  // Arms, never twinned: the screen-right hand keeps the phone; the screen-left hand acts on every beat.
  const phone = b.phone;
  const cheerL = Math.max(0, p.cheerL);
  const handA = reach([sx - 18, sy + 3], freeHand(time, b));
  limb(g, [[sx - 18, sy + 3], elbow([sx - 18, sy + 3], handA, -1), handA], 9, INK.sweaterShade);
  // Screen-right arm: holds the phone; on the cheer it pumps a bent fist, a few frames after the punch.
  let handB: [number, number] = [phone[0] + 8, phone[1] + 6];
  handB = [lerp(handB[0], sx + 34, Math.min(1, cheerL)), lerp(handB[1], sy - 8, cheerL)];
  limb(g, [[sx + 18, sy + 3], elbow([sx + 18, sy + 3], handB, 1), handB], 9, INK.sweater);
  // The phone, its back to us, its light spilling up, held in the screen-right hand.
  const ph: [number, number] = cheerL > 0.2 ? [handB[0], handB[1] + 4] : phone;
  g.fillStyle = INK.phone;
  roundRect(g, ph[0] - 8, ph[1] - 13, 16, 26, 3);
  g.fill();
  if (glow > 0) {
    const spill = g.createRadialGradient(ph[0], ph[1] - 16, 2, ph[0], ph[1] - 16, 40);
    spill.addColorStop(0, rgba(INK.glow, 0.35 * glow));
    spill.addColorStop(1, rgba(INK.glow, 0));
    g.fillStyle = spill;
    g.beginPath();
    g.arc(ph[0], ph[1] - 16, 40, 0, TAU);
    g.fill();
  }
  g.fillStyle = skin;
  g.beginPath();
  g.arc(handA[0], handA[1], 5, 0, TAU);
  g.arc(handB[0], handB[1], 5, 0, TAU);
  g.fill();
  g.fillStyle = INK.skinShade;
  g.fillRect(sx - 4.5, sy - 12, 9, 10);
  const tilt = 0.05 * wander(time / 40, 5) - 0.04 * p.lean + 0.05 * p.look - 0.07 * p.twist + 0.1 * p.turn;
  head(g, b.head[0], b.head[1], { tilt, look: clamp(p.look), turn: clamp(p.turn, -1, 1), smile: clamp(p.smile), glow: Math.max(0, glow), day, lag }, time);
}
