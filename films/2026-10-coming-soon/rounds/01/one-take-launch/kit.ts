/** Frames per beat at 120 BPM; every cue, arrival and hit of the look lands on this grid. */
export const FPB = 30;
export const W = 1080;
export const H = 1920;
export const CX = W / 2;
export const CY = H / 2;
export const TAU = Math.PI * 2;

export type G = CanvasRenderingContext2D;

/** A value in [0, 1) from an integer and a seed: every random value of the look passes through it. */
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
export function inOut(u: number): number {
  const c = clamp(u);
  return c < 0.5 ? 4 * c * c * c : 1 - ((-2 * c + 2) ** 3) / 2;
}
/** Progress of `time` across [a, b] frames, clamped. */
export function prog(time: number, a: number, b: number): number {
  return clamp((time - a) / (b - a));
}

/** Beat to frame. */
export function bf(beat: number): number {
  return Math.round(beat * FPB);
}

/** A spring's stiffness: `hz` its ringing frequency, `damp` its decay per second. */
export interface Spring {
  hz: number;
  damp: number;
}

/** Stiffness by role: snappy for UI, default for cards, heavy for type and the facade, playful for letters. */
export const SNAPPY: Spring = { hz: 3.6, damp: 14 };
export const DEFAULT: Spring = { hz: 2.2, damp: 8 };
export const HEAVY: Spring = { hz: 1.5, damp: 6.5 };
export const PLAYFUL: Spring = { hz: 2.8, damp: 5 };
/** The camera: a glide that settles with a small overshoot. */
export const GLIDE: Spring = { hz: 0.9, damp: 4.2 };

/**
 * The closed-form step response of a damped spring from 0 to 1, starting at
 * `start` frames with zero velocity: 1 − e^(−a·t)(cos ω t + (a/ω) sin ω t).
 */
export function spring(time: number, start: number, s: Spring): number {
  const t = (time - start) / 60;
  if (t <= 0) {
    return 0;
  }
  const w = TAU * s.hz;
  const a = s.damp;
  return 1 - Math.exp(-a * t) * (Math.cos(w * t) + (a / w) * Math.sin(w * t));
}

/** A value with many targets: its start plus one spring per change, each from the last target to the next. */
export function springs(time: number, start: number, keys: readonly (readonly [number, number, Spring?])[], s: Spring): number {
  let value = start;
  let last = start;
  for (const [frame, target, own] of keys) {
    value += (target - last) * spring(time, frame, own ?? s);
    last = target;
  }
  return value;
}

/** A decaying envelope summed over every hit frame at or before `time`: 1 on the hit, `half` frames to halve. */
export function env(time: number, hits: readonly number[], half = 6): number {
  let sum = 0;
  for (const h of hits) {
    const d = time - h;
    if (d >= 0 && d < half * 10) {
      sum += 0.5 ** (d / half);
    }
  }
  return sum;
}

/** 0 on the beat, rising to 1 before the next. */
export function beatPhase(time: number): number {
  const p = (time / FPB) % 1;
  return p < 0 ? p + 1 : p;
}

/** A pulse of 1 on each beat decaying across it. */
export function beatPulse(time: number, sharp = 5): number {
  return Math.exp(-sharp * beatPhase(time));
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

/** A colour through a list of keys, each `[frame, colour]`, blended across each span. */
export function keyed(time: number, keys: readonly (readonly [number, string])[]): string {
  const first = keys[0];
  if (first === undefined) {
    throw new Error('one-take-launch: a colour key list is empty');
  }
  if (time <= first[0]) {
    return first[1];
  }
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1] as readonly [number, string];
    const b = keys[i] as readonly [number, string];
    if (time <= b[0]) {
      return mix(a[1], b[1], smooth((time - a[0]) / (b[0] - a[0])));
    }
  }
  return (keys.at(-1) as readonly [number, string])[1];
}

export function roundRect(g: G, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.arcTo(x + w, y, x + w, y + rr, rr);
  g.lineTo(x + w, y + h - rr);
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  g.lineTo(x + rr, y + h);
  g.arcTo(x, y + h, x, y + h - rr, rr);
  g.lineTo(x, y + rr);
  g.arcTo(x, y, x + rr, y, rr);
  g.closePath();
}

/** A rectangle in some space: its left, top, width and height. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function lerpBox(a: Box, b: Box, u: number): Box {
  return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), w: lerp(a.w, b.w, u), h: lerp(a.h, b.h, u) };
}

/** The palette of the take; Signal Red is never here, it arrives only through `ctx.brand`. */
export const INK = {
  night: '#0b1024',
  nightHigh: '#18204a',
  dusk: '#2a2350',
  dawnLow: '#f4b98a',
  dawnMid: '#e9a3a8',
  dawnHigh: '#8fa6d6',
  morning: '#f6d9b0',
  wall: '#3a3046',
  wallDay: '#c9b39a',
  brick: '#5a4658',
  trim: '#2a2234',
  trimDay: '#7c6650',
  gold: '#ffd27a',
  bulb: '#fff1c6',
  warm: '#ffb85c',
  paper: '#efe6d2',
  paperShade: '#d9cdb2',
  ink: '#1d1a24',
  felt: '#1c1a20',
  floor: '#2b2030',
  seat: '#7b3b52',
  seatTop: '#9a4e68',
  screen: '#e9e4f5',
  skin: '#b57a55',
  skinShade: '#8f5a3d',
  hair: '#1e1620',
  sweater: '#e2a93b',
  sweaterShade: '#b98222',
  trousers: '#2c3557',
  phone: '#14121a',
  glow: '#bcd4ff',
  lamp: '#ffe3a6',
  asphalt: '#1a1c2a',
  paving: '#5a5870',
  pavingDay: '#b8aa9a',
  ui: '#211e1c',
  uiCard: '#2b2724',
  uiLine: '#4a443f',
  uiText: '#f3eee8',
  uiMuted: '#a39a92',
};
