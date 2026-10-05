import { FPB } from './beats.js';

export const W = 1080;
export const H = 1920;
export const CX = W / 2;
export const CY = H / 2;
export const TAU = Math.PI * 2;

export type G = CanvasRenderingContext2D;

/**
 * The take's seed, drawn once per call from the look host's seeded source, so
 * every random value of the look derives from it.
 */
let SEED = 0;
export function setSeed(seed: number): void {
  SEED = seed | 0;
}

/** A value in [0, 1) from an integer and a salt, mixed with the take's seed. */
export function hash(n: number, salt = 0): number {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((salt | 0) + SEED, 0xc2b2ae35);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** A signed value in [-1, 1). */
export function hs(n: number, salt = 0): number {
  return hash(n, salt) * 2 - 1;
}

export function clamp(v: number, lo = 0, hi = 1): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}
export function smooth(u: number): number {
  const c = clamp(u);
  return c * c * (3 - 2 * c);
}
export function outCubic(u: number): number {
  const c = 1 - clamp(u);
  return 1 - c * c * c;
}
export function inCubic(u: number): number {
  const c = clamp(u);
  return c * c * c;
}
export function outBack(u: number, s = 1.70158): number {
  const c = clamp(u) - 1;
  return 1 + c * c * ((s + 1) * c + s);
}
/** Progress of `time` across [a, b] frames, clamped. */
export function prog(time: number, a: number, b: number): number {
  return clamp((time - a) / (b - a));
}

/** A closed-form spring step from 0 to 1 starting at frame `start`: `hz` its frequency, `damp` its decay per second. */
export function spring(time: number, start: number, hz = 3, damp = 7): number {
  const t = (time - start) / 60;
  if (t <= 0) {
    return 0;
  }
  return 1 - Math.exp(-damp * t) * Math.cos(TAU * hz * t);
}

export interface Stiffness {
  hz: number;
  damp: number;
}
/** Stiffness by role: snappy UI, default containers and camera, heavy big type, playful letters. */
export const SNAPPY: Stiffness = { hz: 4.2, damp: 11 };
export const DEFAULT: Stiffness = { hz: 2.6, damp: 7 };
export const HEAVY: Stiffness = { hz: 1.8, damp: 6 };
export const PLAYFUL: Stiffness = { hz: 3.2, damp: 4.5 };

export function springOf(time: number, start: number, s: Stiffness): number {
  return spring(time, start, s.hz, s.damp);
}

/**
 * A decaying envelope summed over every hit frame at or before `time`: 1 on the
 * hit, `half` frames to halve. It reads the whole frame, so both motion-blur
 * sub-frames of a hit frame take the same value and a hit never double-exposes.
 */
export function env(time: number, hits: readonly number[], half = 6): number {
  const frame = Math.round(time);
  let sum = 0;
  for (const h of hits) {
    const d = frame - h;
    if (d >= 0 && d < half * 8) {
      sum += 0.5 ** (d / half);
    }
  }
  return sum;
}

/** 0 on the beat, rising to 1 before the next. */
export function beatPhase(time: number, every = FPB): number {
  const p = (time / every) % 1;
  return p < 0 ? p + 1 : p;
}

/** A pulse of 1 on each beat decaying across it. */
export function beatPulse(time: number, every = FPB, sharp = 5): number {
  return Math.exp(-sharp * beatPhase(time, every));
}

/** A smooth wander in [-1, 1] on incommensurate sines, phased per part by its seed. */
export function wander(t: number, seed: number): number {
  const a = hash(seed * 3 + 1, 91) * TAU;
  const b = hash(seed * 3 + 2, 91) * TAU;
  const c = hash(seed * 3 + 3, 91) * TAU;
  return Math.sin(t * 0.73 + a) * 0.5 + Math.sin(t * 1.37 + b) * 0.3 + Math.sin(t * 2.91 + c) * 0.2;
}

/** Line boil: a jitter re-rolled `rate` times a second, seeded per point. */
export function boil(time: number, point: number, rate = 8, salt = 0): number {
  return hs(point * 131 + Math.floor((time / 60) * rate) * 7919, salt);
}

export function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${String((n >> 16) & 255)},${String((n >> 8) & 255)},${String(n & 255)},${String(clamp(alpha))})`;
}

export function mix(a: string, b: string, u: number): string {
  const x = Number.parseInt(a.slice(1), 16);
  const y = Number.parseInt(b.slice(1), 16);
  const c = (s: number): number => Math.round(lerp((x >> s) & 255, (y >> s) & 255, clamp(u)));
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, '0')}`;
}

/**
 * The take's colours. Signal Red is never here: it reaches the look only
 * through `ctx.brand`, on the spiral and the wordmark.
 */
export const P = {
  night: '#0a0e24',
  night2: '#19204c',
  ink: '#06081a',
  cream: '#f6ecd6',
  paper: '#efe5cc',
  paperShade: '#d6c8a8',
  dim: '#5b5d8c',
  lilac: '#a99cff',
  violet: '#5a43b5',
  violetHi: '#8f7bff',
  amber: '#ffbd52',
  amberHot: '#ffe3a3',
  teal: '#5ad8c9',
  skin: '#ffd3ad',
  coat: '#f2b33d',
  legs: '#3a3f86',
  dawnTop: '#2c3270',
  dawnMid: '#d9925c',
  dawnLow: '#ffd79e',
  inkDark: '#1b1830',
} as const;
