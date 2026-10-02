/** Frames per beat at 112.5 BPM; the grid every hit and cut of the look lands on. */
export const FPB = 32;
/** The tempo the HUD reads out, from the frames per beat at 60 fps. */
export const BPM = (60 * 60) / FPB;
/** The film's length in beats. */
export const BEATS = 75;
export const W = 1080;
export const H = 1920;
export const CX = W / 2;
export const CY = H / 2;
export const TAU = Math.PI * 2;

export type G = CanvasRenderingContext2D;

/** A value in [0, 1) from an integer and a seed: every random value of the look passes through it. */
export function hash(n: number, seed = 0): number {
  let x = Math.imul(n ^ 0x9e_37_79_b9, 0x85_eb_ca_6b) ^ Math.imul(seed, 0xc2_b2_ae_35);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7f_eb_35_2d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x84_6c_a6_8b);
  x ^= x >>> 16;
  return (x >>> 0) / 4_294_967_296;
}

/** A signed value in [-1, 1). */
export function hs(n: number, seed = 0): number {
  return hash(n, seed) * 2 - 1;
}

/** The element at an index the caller has bounded by the list's length; an index outside it is a defect, refused by name. */
export function nth<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(
      `2026-09-all-but-one: index ${String(index)} lies outside ${String(values.length)} values`
    );
  }
  return value;
}

export function clamp(v: number, lo = 0, hi = 1): number {
  if (v < lo) {
    return lo;
  }
  if (v > hi) {
    return hi;
  }
  return v;
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
export function outExpo(u: number): number {
  const c = clamp(u);
  return c >= 1 ? 1 : 1 - 2 ** (-10 * c);
}
/** Progress of `time` across [a, b] frames, clamped. */
export function prog(time: number, a: number, b: number): number {
  return clamp((time - a) / (b - a));
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

/** Stiffness by role, as craft asks: snappy UI, default containers, heavy type, playful stickers. */
export const SNAPPY = { hz: 4.2, damp: 11 };
export const DEFAULT = { hz: 2.6, damp: 7 };
export const HEAVY = { hz: 1.8, damp: 6 };
export const PLAYFUL = { hz: 3.2, damp: 4 };

export function springOf(time: number, start: number, s: { hz: number; damp: number }): number {
  return spring(time, start, s.hz, s.damp);
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

/** 0 on the beat, rising to 1 before the next: a beat-locked phase. */
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
  const a = hash(seed * 3 + 1) * TAU;
  const b = hash(seed * 3 + 2) * TAU;
  const c = hash(seed * 3 + 3) * TAU;
  return Math.sin(t * 0.73 + a) * 0.5 + Math.sin(t * 1.37 + b) * 0.3 + Math.sin(t * 2.91 + c) * 0.2;
}

/** Line boil: a jitter re-rolled `rate` times a second, seeded per point. */
export function boil(time: number, point: number, rate = 10, seed = 0): number {
  return hs(point * 131 + Math.floor((time / 60) * rate) * 7919, seed);
}

/** Beat to frame. */
export function bf(beat: number): number {
  return Math.round(beat * FPB);
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

/** Numbers as the HUD counts them: grouped by thousands. */
export function grouped(n: number): string {
  return Math.floor(n).toLocaleString('en-US');
}

/** A polyline through points, drawn on up to fraction `p` of its length (by point count). */
export function polyline(
  g: G,
  pts: readonly (readonly [number, number])[],
  p = 1,
  closed = false
): void {
  const n = pts.length;
  if (n < 2 || p <= 0) {
    return;
  }
  const segs = closed ? n : n - 1;
  const reach = segs * clamp(p);
  const whole = Math.floor(reach);
  g.beginPath();
  const first = nth(pts, 0);
  g.moveTo(first[0], first[1]);
  for (let index = 1; index <= whole; index++) {
    const q = nth(pts, index % n);
    g.lineTo(q[0], q[1]);
  }
  const frac = reach - whole;
  if (frac > 0 && whole < segs) {
    const a = nth(pts, whole % n);
    const b = nth(pts, (whole + 1) % n);
    g.lineTo(lerp(a[0], b[0], frac), lerp(a[1], b[1], frac));
  }
  g.stroke();
}

/** Palettes the cut flips between. Signal Red is never here: it arrives only through `ctx.brand`. */
export const INK = {
  bg: '#010101',
  line: '#e2b866',
  hot: '#fff0c2',
  key: '#ff7a1a',
  dim: '#3a2a12',
};
export const PARCH = {
  bg: '#e8dbbd',
  line: '#2b1d0f',
  hot: '#120b04',
  key: '#c2410c',
  dim: '#b9a67f',
};
export const SURV = {
  bg: '#020a12',
  line: '#63dcff',
  hot: '#e6fbff',
  key: '#d7ff3a',
  dim: '#12384a',
};
export const HELL = {
  bg: '#040101',
  line: '#ff6a14',
  hot: '#ffe08a',
  key: '#ffd23a',
  dim: '#3b1006',
};
export const NIGHT = {
  bg: '#02040c',
  line: '#8fa2ff',
  hot: '#ffd98a',
  key: '#ff7a1a',
  dim: '#1a2150',
};

export type Palette = typeof INK;
