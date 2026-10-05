import { FPB } from './score.js';

export { FPB };
export const W = 1080;
export const H = 1920;
export const CX = W / 2;
export const CY = H / 2;
export const TAU = Math.PI * 2;

export type G = CanvasRenderingContext2D;
export type Pt = readonly [number, number];

/** A value in [0, 1) from an integer and a seed: every procedural value of the look passes through it. */
export function hash(n: number, seed = 0): number {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seed | 0, 0xc2b2ae35);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** A signed value in [-1, 1). */
export function hs(n: number, seed = 0): number {
  return hash(n, seed) * 2 - 1;
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
export function inOut(u: number): number {
  const c = clamp(u);
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
}
/** Progress of `time` across [a, b] frames, clamped. */
export function prog(time: number, a: number, b: number): number {
  return clamp((time - a) / (b - a));
}

/** Beat to frame. */
export function bf(beat: number): number {
  return Math.round(beat * FPB);
}

/**
 * A closed-form spring step from 0 to 1 starting at `start` frames, with an
 * overshoot that settles: `hz` its frequency, `damp` its decay per second.
 */
export function spring(time: number, start: number, hz = 3, damp = 7): number {
  const t = (time - start) / 60;
  if (t <= 0) {
    return 0;
  }
  return 1 - Math.exp(-damp * t) * Math.cos(TAU * hz * t);
}

/** Stiffness by role: snappy UI, default containers and camera, heavy objects, a playful figure. */
export const SNAPPY = { hz: 4, damp: 11 };
export const DEFAULT = { hz: 2.4, damp: 7.5 };
export const HEAVY = { hz: 1.7, damp: 6.5 };
export const PLAYFUL = { hz: 2.8, damp: 5 };

export function springOf(time: number, start: number, s: { hz: number; damp: number }): number {
  return spring(time, start, s.hz, s.damp);
}

/**
 * An impact's squash, by frames since contact: 1 squashed flat on contact and
 * held a frame, recoiling past rest into a stretch (negative), then settling.
 * Zero before contact.
 */
export function impact(age: number): number {
  if (age < 0) {
    return 0;
  }
  if (age < 2) {
    return 1;
  }
  const t = age - 2;
  return Math.exp(-0.17 * t) * Math.cos(0.42 * t);
}

/** A decaying envelope summed over every hit frame at or before `time`: 1 on the hit, `half` frames to halve. */
export function env(time: number, hits: readonly number[], half = 6): number {
  let sum = 0;
  for (const h of hits) {
    const d = time - h;
    if (d >= 0 && d < half * 8) {
      sum += 0.5 ** (d / half);
    }
  }
  return sum;
}

/** A smooth wander in [-1, 1] on incommensurate sines, phased per part by its seed. */
export function wander(t: number, seed: number): number {
  const a = hash(seed * 3 + 1) * TAU;
  const b = hash(seed * 3 + 2) * TAU;
  const c = hash(seed * 3 + 3) * TAU;
  return Math.sin(t * 0.73 + a) * 0.5 + Math.sin(t * 1.37 + b) * 0.3 + Math.sin(t * 2.91 + c) * 0.2;
}

/** Line boil: a jitter re-rolled `rate` times a second, seeded per point. */
export function boil(time: number, point: number, rate = 8, seed = 0): number {
  return hs(point * 131 + Math.floor((time / 60) * rate) * 7919, seed);
}

/** The boil frame index: lines re-roll on it. */
export function boilTick(time: number, rate = 8): number {
  return Math.floor((time / 60) * rate);
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

/** A colour of the brand stylesheet as `#rrggbb`, whatever CSS syntax it was written in. */
export function hexOf(css: string): string {
  if (/^#[0-9a-f]{6}$/i.test(css)) {
    return css.toLowerCase();
  }
  const cached = HEX.get(css);
  if (cached !== undefined) {
    return cached;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (g === null) {
    throw new Error('storybook-short: no 2D context to resolve a brand colour');
  }
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gg = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
  const out = `#${((r << 16) | (gg << 8) | b).toString(16).padStart(6, '0')}`;
  HEX.set(css, out);
  return out;
}
const HEX = new Map<string, string>();

/** The take's palette: the night she works in, the gold the answers build in, the dawn she opens in. */
export const NIGHT = {
  wall: '#1e2448',
  wallDeep: '#151a37',
  floor: '#171c3b',
  rim: '#7182c7',
  rimSoft: '#4a5797',
  ink: '#1b1622',
  glow: '#ffcf7a',
  sky: '#121733',
  skyLow: '#2b3570',
  moon: '#f4ead2',
};
export const DAY = {
  paper: '#f6ecd8',
  ink: '#2b211c',
  sky: '#f4a98a',
  skyHigh: '#8fb2e2',
  sun: '#ffe08a',
  wall: '#f0d3ab',
  wallDeep: '#dcb48a',
  floor: '#e4c296',
};
/** Her colours, warm against the night. */
export const HER = {
  skin: '#f1c8a2',
  skinShade: '#d9a27e',
  sweater: '#df9f35',
  sweaterShade: '#b97c22',
  trousers: '#3e4f88',
  hair: '#4d2e22',
  blush: '#eaa08e',
  pencil: '#f0c94a',
};
/** The gold every answer builds in. */
export const GOLD = '#f2c35b';
export const GOLD_HOT = '#fff0bf';
/** The app's own surfaces, as the dark theme draws them. */
export const APP = {
  bg: '#1a1816',
  paper: '#252320',
  subtle: '#2d2b28',
  fg: '#f2f1ef',
  muted: '#bcb9b3',
};
/** Seat velvet: teal, so Signal Red stays HushBox's alone. */
export const VELVET = '#2f6f74';
export const VELVET_DEEP = '#1f4f55';

/** A value moving through keyed frames, eased between each pair; held before the first and after the last. */
export function keyed(time: number, keys: readonly (readonly [number, number])[], ease: (u: number) => number = inOut): number {
  const first = keys[0];
  if (first === undefined) {
    return 0;
  }
  if (time <= first[0]) {
    return first[1];
  }
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1] as readonly [number, number];
    const b = keys[i] as readonly [number, number];
    if (time <= b[0]) {
      return lerp(a[1], b[1], ease((time - a[0]) / (b[0] - a[0])));
    }
  }
  return (keys.at(-1) as readonly [number, number])[1];
}

/** A value that springs to each keyed target at its frame: one spring per change, summed. */
export function sprung(time: number, base: number, keys: readonly (readonly [number, number])[], s: { hz: number; damp: number } = DEFAULT): number {
  let prev = base;
  let value = base;
  for (const [frame, target] of keys) {
    value += (target - prev) * springOf(time, frame, s);
    prev = target;
  }
  return value;
}

/** Zoom interpolated in log space between two framings. */
export function logZoom(a: number, b: number, u: number): number {
  return Math.exp(lerp(Math.log(a), Math.log(b), u));
}

/** A camera: the world point (cx, cy) at the frame's centre, zoomed and rolled. */
export interface Cam {
  z: number;
  cx: number;
  cy: number;
  roll: number;
}

export function applyCam(g: G, c: Cam): void {
  g.translate(W / 2, H / 2);
  g.rotate(c.roll);
  g.scale(c.z, c.z);
  g.translate(-c.cx, -c.cy);
}

/** Where a world point lands on the frame under a camera. */
export function toScreen(c: Cam, [x, y]: Pt): Pt {
  const dx = (x - c.cx) * c.z;
  const dy = (y - c.cy) * c.z;
  const co = Math.cos(c.roll);
  const si = Math.sin(c.roll);
  return [W / 2 + dx * co - dy * si, H / 2 + dx * si + dy * co];
}
