// Closed-form motion: every value here is a function of the instant alone, so any
// frame draws the same pixels in any order.

export const FPS = 60;

/** A spring's natural frequency (rad/s) and damping ratio. */
export interface Spring {
  w: number;
  z: number;
}

/** Stiffness by role: snappy for UI, default for cards and camera, heavy for big type and the mark, playful for the Devil. */
export const SNAPPY: Spring = { w: 32, z: 0.52 };
export const CARD: Spring = { w: 19, z: 0.56 };
export const HEAVY: Spring = { w: 11.5, z: 0.64 };
export const PLAYFUL: Spring = { w: 17, z: 0.3 };
export const CAMERA: Spring = { w: 9, z: 0.8 };

/**
 * The unit step response of a spring released at frame 0, at `frames` after it:
 * 0 before, overshooting and settling to 1 after.
 */
export function step(frames: number, s: Spring): number {
  if (frames <= 0) {
    return 0;
  }
  const t = frames / FPS;
  if (s.z >= 1) {
    return 1 - Math.exp(-s.w * t) * (1 + s.w * t);
  }
  const wd = s.w * Math.sqrt(1 - s.z * s.z);
  const decay = Math.exp(-s.z * s.w * t);
  return 1 - decay * (Math.cos(wd * t) + ((s.z * s.w) / wd) * Math.sin(wd * t));
}

/** A small wind-up before a move: a dip of `depth` (in the move's units, as a share of it) over `frames` before the start. */
export function windup(framesToStart: number, depth: number, frames = 9): number {
  if (framesToStart <= 0 || framesToStart >= frames) {
    return 0;
  }
  const u = 1 - framesToStart / frames;
  return -depth * Math.sin(Math.PI * u) * u;
}

/** One move of a keyed value: at `at` it heads for `to` on spring `s`, winding up by `antic` first. */
export interface Key {
  at: number;
  to: number;
  s?: Spring;
  antic?: number;
}

/**
 * A value with many targets: the sum of one spring per change, each springing
 * from the previous target to its own.
 */
export function keyed(frame: number, from: number, keys: readonly Key[]): number {
  let value = from;
  let previous = from;
  for (const key of keys) {
    const delta = key.to - previous;
    const s = key.s ?? CARD;
    value += delta * step(frame - key.at, s);
    if (key.antic !== undefined) {
      value += delta * windup(key.at - frame, key.antic);
    }
    previous = key.to;
  }
  return value;
}

/** A keyed value interpolated in log space: zoom and scale, so each doubling takes the same time. */
export function keyedLog(frame: number, from: number, keys: readonly Key[]): number {
  return Math.exp(
    keyed(
      frame,
      Math.log(from),
      keys.map((k) => ({ ...k, to: Math.log(k.to) }))
    )
  );
}

export function clamp(v: number, lo = 0, hi = 1): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/** Progress of `frame` through `[from, to]`, clamped. */
export function span(frame: number, from: number, to: number): number {
  return clamp((frame - from) / (to - from));
}

export function easeInOut(u: number): number {
  const c = clamp(u);
  return c * c * (3 - 2 * c);
}

export function easeOut(u: number): number {
  const c = clamp(u);
  return 1 - (1 - c) ** 3;
}

export function easeIn(u: number): number {
  const c = clamp(u);
  return c * c * c;
}

/** An exponential expo-out, the keynote move: fast start, long settle. */
export function expoOut(u: number): number {
  const c = clamp(u);
  return c >= 1 ? 1 : 1 - 2 ** (-10 * c);
}

/**
 * An impact envelope: a ramp over the frame and a half before `at` that peaks on
 * it, then an exponential decay over roughly `frames`. The ramp keeps it
 * continuous, so motion-blur samples either side of a hit never split into a
 * double exposure, and the hit's own frame already shows it.
 */
export function hit(frame: number, at: number, frames = 12): number {
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

/** The envelope of whichever beat of `every` frames (offset by `offset`) is nearest behind or just ahead. */
export function onBeats(frame: number, every: number, offset = 0, frames = 12): number {
  const k = Math.floor((frame - offset) / every);
  return Math.max(hit(frame, offset + k * every, frames), hit(frame, offset + (k + 1) * every, frames));
}

/** The index of the beat of `every` frames whose envelope `onBeats` is reading. */
export function beatIndex(frame: number, every: number, offset = 0): number {
  return Math.floor((frame - offset + 1.5) / every);
}

/** Two incommensurate sines with a seeded phase: idle breathing that never repeats in unison. */
export function wob(t: number, phase: number, rate = 1): number {
  return 0.62 * Math.sin(t * 0.071 * rate + phase * 6.283) + 0.38 * Math.sin(t * 0.1618 * rate + phase * 11.7 + 1.3);
}

/** Integer hash to [0, 1): the boil's re-roll index into a seeded table. */
export function hashIndex(a: number, b: number, size: number): number {
  const h = Math.imul(a ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  return ((h ^ (h >>> 15)) >>> 0) % size;
}

/** An arc between two points: the point at `u` along a quadratic bend of `bend` pixels to the left of travel. */
export function arcPoint(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  u: number,
  bend: number
): [number, number] {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const cx = mx - (dy / len) * bend;
  const cy = my + (dx / len) * bend;
  const v = 1 - u;
  return [v * v * ax + 2 * v * u * cx + u * u * bx, v * v * ay + 2 * v * u * cy + u * u * by];
}
