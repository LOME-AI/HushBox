/**
 * The direction of every instant: which worlds are on screen, where each
 * world's camera is, every world parameter the shaders read, and the finish.
 * Everything is closed-form in the time `t` (seconds), so any instant draws
 * alone. Beat n falls at n / 2 s (120 BPM).
 */

export type V4 = readonly [number, number, number, number];

export interface Cam {
  x: number;
  y: number;
  zoom: number;
  roll: number;
}

export interface Layer {
  world: number;
  count: number;
  gain: number;
  cam: Cam;
  a: V4;
  b: V4;
  c: V4;
  d: V4;
  e: V4;
  f: V4;
  g: V4;
  face0: V4;
  face1: V4;
  face2: V4;
  face3: V4;
}

export interface Finish {
  exposure: number;
  flash: V4;
  bloom: number;
  aberration: number;
  vignette: number;
  direct: number;
  tint: readonly [number, number, number];
  /** Camera shake in pixels. */
  shake: readonly [number, number];
}

export interface Shot {
  layers: Layer[];
  finish: Finish;
}

const ZERO: V4 = [0, 0, 0, 0];

// ---------------------------------------------------------------- closed-form motion

export function clamp(x: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, x));
}
export function ease(x: number): number {
  const u = clamp(x);
  return u * u * (3 - 2 * u);
}
function easeIn(x: number): number {
  const u = clamp(x);
  return u * u * u;
}
function easeOut(x: number): number {
  const u = 1 - clamp(x);
  return 1 - u * u * u;
}
function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}
/** A damped spring's step response from 0 to 1, started at t0: `hz` its frequency, `damping` its ratio. */
function spring(t: number, t0: number, hz: number, damping: number): number {
  const s = t - t0;
  if (s <= 0) {
    return 0;
  }
  const w = 2 * Math.PI * hz;
  const wd = w * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-damping * w * s) * (Math.cos(wd * s) + ((damping * w) / wd) * Math.sin(wd * s));
}
/** Stiffness by role: snappy for small parts, default for faces, heavy for the mark, glide for cameras. */
const SNAPPY = (t: number, t0: number): number => spring(t, t0, 4.5, 0.45);
const DEFAULT = (t: number, t0: number): number => spring(t, t0, 2.2, 0.6);
const HEAVY = (t: number, t0: number): number => spring(t, t0, 1.2, 0.5);
const GLIDE = (t: number, t0: number): number => spring(t, t0, 0.55, 0.95);
/** How far ahead of its cue a spring starts, so its first visible change lands on the cue's own frame. */
const LEAD = 0.025;

/** An impact envelope: zero before t0, then an exponential fall. */
function pulse(t: number, t0: number, decay: number): number {
  return t < t0 ? 0 : Math.exp(-(t - t0) / decay);
}
/** A value that moves through keyed targets, one spring per change, summed. */
function keyed(t: number, start: number, keys: readonly (readonly [number, number])[], move = DEFAULT): number {
  let v = start;
  let prev = start;
  for (const [at, to] of keys) {
    v += (to - prev) * move(t, at);
    prev = to;
  }
  return v;
}
/** Zoom interpolated in log space. */
function logZoom(from: number, to: number, u: number): number {
  return Math.exp(lerp(Math.log(from), Math.log(to), u));
}
/** Two incommensurate sines with a seeded phase: idle motion that never repeats in the film. */
function idle(t: number, seed: number, amp: number): number {
  return amp * (0.6 * Math.sin(t * 1.37 + seed) + 0.4 * Math.sin(t * 2.71 + seed * 1.9));
}
/** A struck body's give: it compresses on the hit, rebounds past rest and settles. */
function give(t: number, t0: number): number {
  const s = t - t0;
  return s < 0 ? 0 : Math.exp(-s / 0.2) * Math.cos(2 * Math.PI * 2.6 * s);
}

// ---------------------------------------------------------------- the beat and the cues, in seconds

const B = (beat: number): number => beat / 2;

const T_BURST = B(2);
const T_FORMED = B(4);
const T_GALAXY = B(9);
const T_EYE = B(13);
const T_CRACK = B(16.5);
const T_GATHER = B(19);
const T_INHALE = B(19.5);
const T_DROP = B(20);
const T_DEMONS = [B(21), B(22), B(23)] as const;
const T_PLANET = B(24);
const T_STRIKE = B(25.5);
const T_FIELD = B(28);
const T_HUSH = B(31);
const T_ONE = B(32);
const T_CLAW = B(33.5);
const T_BURN = B(35);
const T_RED = B(37);
const T_VALUES = [B(41), B(47)] as const;
const T_COLLAPSE = B(52);
const T_LAST = B(55);
const T_FINAL = B(56);

/** A flash that swells into its cue and falls away after it. */
function flashAt(t: number, t0: number, amount: number, decay = 0.09, pre = 0.07): number {
  if (t >= t0) {
    return amount * Math.exp(-(t - t0) / decay);
  }
  return pre > 0 ? amount * 0.55 * ease((t - (t0 - pre)) / pre) : 0;
}

/** A shake of `px` pixels that dies over `decay` seconds, never twinned on its two axes. */
function shake(t: number, t0: number, px: number, decay: number): [number, number] {
  const s = t - t0;
  if (s < 0) {
    return [0, 0];
  }
  const a = px * Math.exp(-s / decay);
  return [a * Math.sin(s * 71), a * Math.cos(s * 57)];
}

function addShake(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] + b[0], a[1] + b[1]];
}

type Parts = Partial<Omit<Layer, 'world' | 'count' | 'gain' | 'cam'>>;

function layer(world: number, count: number, gain: number, cam: Cam, parts: Parts): Layer {
  return {
    world,
    count,
    gain,
    cam,
    a: ZERO,
    b: ZERO,
    c: ZERO,
    d: ZERO,
    e: ZERO,
    f: ZERO,
    g: ZERO,
    face0: ZERO,
    face1: ZERO,
    face2: ZERO,
    face3: ZERO,
    ...parts,
  };
}

// ---------------------------------------------------------------- world 0: the ember and the Devil

const FACE_C: readonly [number, number] = [0, 0.34];
const FACE_S = 0.78;
/** The grin's centre in world units: the dive's target. */
const GRIN: readonly [number, number] = [0, FACE_C[1] - 0.255 * FACE_S];

/**
 * The Devil acts on every beat from the moment he forms: eyes open (4), a look
 * aside (4.5), the grin widens with a tilt (5), a wink (5.5), he leans in (6),
 * brows up (6.5), a laugh on the eighths (7), and the jaw drops for the dive (8).
 */
function worldVoid(t: number): Layer {
  const heart = 0.55 + 1.3 * pulse(t, 0, 0.09) + 0.8 * pulse(t, 0.2, 0.08) + 1.3 * pulse(t, 0.5, 0.09) + 0.8 * pulse(t, 0.7, 0.08);
  const inhale = 1 - 0.8 * ease((t - 0.82) / 0.18);
  const ember = t < T_BURST ? heart * inhale * (0.6 + 0.6 * ease(t / 0.9)) : 0;
  const formed = ease((t - 1.8) / 0.6);
  const grin = 0.15 + 0.9 * SNAPPY(t, B(5)) - 0.35 * SNAPPY(t, B(6)) + 0.3 * SNAPPY(t, B(6.5));
  const laughing = t > B(7.5) && t < B(8) ? Math.abs(Math.sin(2 * Math.PI * 2 * (t - B(7.5)))) : 0;
  const open = 0.3 * SNAPPY(t, B(6)) - 0.3 * SNAPPY(t, B(6.5)) + 0.45 * laughing + 0.9 * ease((t - B(8)) / 0.35);
  // the eyes open a few frames apart, the left last
  const blink = 1 - SNAPPY(t, T_FORMED - 0.08);
  const lagL = 1 - SNAPPY(t, T_FORMED);
  const wink = Math.max(0, Math.sin(Math.PI * clamp((t - (B(7) - 0.15)) / 0.45)));
  const winkL = Math.max(lagL, wink);
  const lookX = keyed(t, 0, [
    [B(4.5), -0.018],
    [B(5.5), 0.016],
    [B(6.5), -0.01],
    [B(7), 0.014],
    [B(8), 0],
  ], SNAPPY);
  const brow = keyed(t, 0, [
    [B(5.5), 1],
    [B(6), -0.4],
    [B(7), 1.2],
    [B(7.5), 0.2],
  ], SNAPPY);
  const lean = 1 + 0.18 * DEFAULT(t, B(6)) - 0.1 * DEFAULT(t, B(6.5)) + 0.05 * DEFAULT(t, B(7));
  const tilt = idle(t, 0.7, 0.02) + 0.2 * DEFAULT(t, B(5)) - 0.36 * DEFAULT(t, B(6)) + 0.26 * DEFAULT(t, B(6.5)) - 0.12 * DEFAULT(t, B(7)) + 0.04 * laughing;
  const bob = 0.03 * laughing + 0.04 * DEFAULT(t, B(6)) - 0.04 * DEFAULT(t, B(6.5));
  const sway = 0.05 * DEFAULT(t, B(5)) - 0.1 * DEFAULT(t, B(6)) + 0.05 * DEFAULT(t, B(6.5));

  let cam: Cam = { x: 0, y: 0, zoom: 1, roll: 0 };
  if (t >= 1.6) {
    const u = ease((t - 1.6) / 2.4);
    cam = { x: idle(t, 2, 0.012) + 0.03 * DEFAULT(t, B(5)), y: lerp(0, -0.03, u) + idle(t, 5, 0.01), zoom: lerp(1, 1.25, u), roll: idle(t, 1, 0.012) - 0.04 * DEFAULT(t, B(6)) };
  }
  if (t >= B(8)) {
    const q = clamp((t - B(8)) / 0.5);
    const u = ease(q * 2);
    cam = {
      x: lerp(cam.x, GRIN[0], u),
      y: lerp(cam.y, GRIN[1], u),
      zoom: 1.25 * Math.exp(3.3 * easeIn(q)),
      roll: cam.roll + 0.25 * easeIn(q),
    };
  }
  return layer(0, 70000, 1 - ease((t - 4.44) / 0.08), cam, {
    a: [ember, t - T_BURST, formed, formed],
    face0: [grin, 0, open, blink],
    face1: [FACE_C[0] + sway, FACE_C[1] + bob, FACE_S * lean, tilt],
    face2: [lookX, 0.004 * Math.sin(t * 3), 1, 0.0035],
    face3: [winkL, 0, brow, 0],
  });
}

// ---------------------------------------------------------------- world 1: the galaxy of words

const GAL_C: readonly [number, number] = [0, 0.3];
/** The galaxy's scale in world units: its outermost arm reaches the frame's sides. */
export const GAL_SCALE = 0.55;
/** How fast the galaxy turns: slow enough that a word holds its shape under the shutter. */
export const GAL_SPIN = 0.12;

/** Where the word the camera dives into sits at time t: the galaxy's formula for its radius, without scatter. */
function targetWord(t: number): [number, number] {
  const r = 0.62;
  const tl = t - T_GALAXY;
  const th = 2.3 * Math.log(r / 0.035) - (0.55 / (r + 0.25)) * (tl + 2) * GAL_SPIN;
  const x = Math.cos(th) * r * GAL_SCALE;
  const y = Math.sin(th) * r * 0.58 * GAL_SCALE;
  const c = Math.cos(0.5);
  const s = Math.sin(0.5);
  return [GAL_C[0] + c * x - s * y, GAL_C[1] + s * x + c * y];
}

function worldGalaxy(t: number): Layer {
  const appear = ease((t - (T_GALAXY - 0.05)) / 0.8);
  const T = targetWord(t);
  const arrive = easeOut((t - (T_GALAXY - 0.06)) / 0.6);
  let cam: Cam = { x: GAL_C[0], y: GAL_C[1], zoom: logZoom(0.04, 1, arrive), roll: -0.15 * (1 - arrive) };
  // a dolly along the arm, close enough that every word is a bubble with lines
  const tour = ease((t - 5.0) / 0.9);
  cam = {
    x: lerp(cam.x, T[0], tour * 0.8),
    y: lerp(cam.y, T[1], tour * 0.8),
    zoom: cam.zoom * lerp(1, 3.0, tour),
    roll: cam.roll + 0.35 * tour + idle(t, 3, 0.01),
  };
  const q = clamp((t - 6.2) / 0.3);
  if (q > 0) {
    cam = { x: lerp(cam.x, T[0], ease(q * 3)), y: lerp(cam.y, T[1], ease(q * 3)), zoom: cam.zoom * Math.exp(2.6 * easeIn(q)), roll: cam.roll + 0.2 * easeIn(q) };
  }
  const glint = ease((t - 5.8) / 0.4) * (1 + 4 * easeIn(q));
  return layer(1, 22000, ease((t - (T_GALAXY - 0.08)) / 0.08) * (1 - ease((t - (T_EYE - 0.04)) / 0.06)), cam, {
    a: [T_GALAXY, appear, 0, 0],
    b: [GAL_C[0], GAL_C[1], T[0], T[1]],
    c: [ease((t - 5.4) / 0.4), glint, q, 0],
  });
}

// ---------------------------------------------------------------- world 2: the eye, the leak, the demons

const EYE_C: readonly [number, number] = [0, 0.14];

/** A demon's centre, scale and formation time. Each forms just before its beat and lands on it with overshoot. */
function demon(t: number, k: number): V4 {
  const form = T_DEMONS[k] ?? 0;
  const pop = k === 0 ? 0.35 + 0.65 * spring(t, form - 0.14, 2.6, 0.28) : 0.6 + 0.4 * spring(t, form - 0.12, 3.2, 0.32);
  if (k === 0) {
    const u = ease((t - 11.0) / 1.0);
    return [lerp(-0.14, -0.4, u), lerp(0.36, 0.64, u), lerp(0.95, 1.25, u) * pop, form];
  }
  if (k === 1) {
    const u = ease((t - 11.5) / 0.55);
    return [lerp(0.17, 0.4, u), lerp(0.14, 0.34, u), lerp(1.0, 1.3, u) * pop, form];
  }
  const u = easeIn((t - 11.72) / 0.3);
  return [lerp(0, 0.05, u), lerp(0.46, 0.2, u), lerp(1.1, 3.2, u) * pop, form];
}

function worldEye(t: number): Layer {
  const gather = t < T_DROP ? Math.min(1.15, SNAPPY(t, T_GATHER - LEAD)) : 0;
  const open = ease((t - (T_EYE + 0.02)) / 0.25) * (1 - 0.45 * gather);
  const look: [number, number] = [
    keyed(t, 0, [
      [B(14.5), -0.12],
      [B(15), -0.05],
      [B(15.5), 0.11],
      [B(16), 0.06],
      [B(16.5), 0],
    ], SNAPPY),
    keyed(t, 0, [
      [B(14.5), 0.03],
      [B(15), -0.02],
      [B(15.5), -0.03],
      [B(16), 0.03],
      [B(16.5), 0],
    ], SNAPPY),
  ];
  const contract = pulse(t, B(14.5), 0.18) + pulse(t, B(15), 0.15) + pulse(t, B(15.5), 0.18) + pulse(t, B(16), 0.15);
  const leak = t < T_CRACK ? 0 : 0.18 + 0.82 * ease((t - T_CRACK) / 1.2);
  const inhale = t < T_DROP ? SNAPPY(t, T_INHALE) : 0;
  const pupil = Math.max(0.012, (0.07 - 0.022 * contract + 0.035 * leak + 0.03 * gather) * (1 - 0.85 * inhale));
  const swell = (1 + 0.22 * ease((t - T_CRACK) / 1.0)) * (1 + 0.08 * gather);
  const hud = (Math.PI / 12) * (SNAPPY(t, B(14.5)) - SNAPPY(t, B(15)) + 2 * SNAPPY(t, B(15.5)) - SNAPPY(t, B(16)) + SNAPPY(t, B(16.5)) + SNAPPY(t, B(18)));
  const arrive = easeOut((t - (T_EYE - 0.05)) / 0.55);
  let cam: Cam = {
    x: EYE_C[0] + look[0] * 0.2,
    y: EYE_C[1] - 0.06 + look[1] * 0.2,
    zoom: logZoom(0.05, 1, arrive) * lerp(1, 1.12, ease((t - 7.0) / 1.5)) * lerp(1, 1.18, ease((t - T_CRACK) / 1.0)) * lerp(1, 0.84, gather),
    roll: idle(t, 4, 0.012) + 0.1 * (1 - arrive) + 0.06 * ease((t - T_CRACK) / 1.0) - 0.08 * gather,
  };
  if (t >= T_INHALE && t < T_DROP) {
    cam = { ...cam, zoom: cam.zoom * lerp(1, 1.6, inhale) };
  }
  if (t >= T_DROP) {
    const after = easeOut((t - T_DROP) / 0.5);
    cam = { x: 0, y: lerp(EYE_C[1], 0.26, after), zoom: lerp(1.35, 1, after), roll: idle(t, 4, 0.02) + 0.05 * DEFAULT(t, T_DEMONS[1]) - 0.05 * DEFAULT(t, T_DEMONS[2]) };
    const q = clamp((t - 11.8) / 0.2);
    if (q > 0) {
      cam = { ...cam, zoom: cam.zoom * Math.exp(-3.2 * easeIn(q)) };
    }
  }
  return layer(2, 60000, ease((t - (T_EYE - 0.06)) / 0.06) * (1 - ease((t - (T_PLANET - 0.03)) / 0.05)), cam, {
    a: [T_EYE, open, swell, inhale],
    b: [look[0], look[1], pupil, hud],
    c: [leak, t - T_DROP, t < T_CRACK ? 0 : 0.28 + 0.8 * easeOut((t - T_CRACK) / 1.4), t - T_CRACK],
    d: demon(t, 0),
    e: demon(t, 1),
    f: demon(t, 2),
    g: [gather, 0, 0, 0],
  });
}

// ---------------------------------------------------------------- world 3: the whole world

function worldPlanet(t: number): Layer {
  const arrive = easeOut((t - (T_PLANET - 0.03)) / 0.6);
  const start: [number, number] = [0.28, 0.58];
  const strikes = [0, 1, 2].reduce((sum, k) => sum + give(t, T_STRIKE + k * 0.5), 0);
  let cam: Cam = {
    x: lerp(start[0], 0, arrive) + idle(t, 7, 0.01),
    y: lerp(start[1], 0.12, arrive),
    zoom: logZoom(25, 1, arrive) * lerp(1, 1.14, ease((t - 12.6) / 1.3)) * (1 + 0.02 * strikes),
    roll: lerp(0.3, 0, arrive) - 0.1 * ease((t - 12.6) / 1.3),
  };
  const q = clamp((t - 13.83) / 0.17);
  if (q > 0) {
    cam = { x: lerp(cam.x, 0, ease(q * 2)), y: lerp(cam.y, 0.2, ease(q * 2)), zoom: cam.zoom * Math.exp(-3.0 * easeIn(q)), roll: cam.roll };
  }
  return layer(3, 54000, ease((t - (T_PLANET - 0.05)) / 0.05) * (1 - ease((t - (T_FIELD - 0.03)) / 0.05)), cam, {
    a: [T_PLANET, T_STRIKE, 0, 0],
  });
}

// ---------------------------------------------------------------- world 4: all of them, and all but one

const P_PLANET: readonly [number, number] = [-0.1, 0.3];
const P_RED: readonly [number, number] = [0.22, 0.52];
const FIELD_FACE = 50000;
const CLAW = 14000;

function worldField(t: number): Layer {
  const arrive = easeOut((t - (T_FIELD - 0.03)) / 0.6);
  const hushed = t >= T_HUSH && t < T_ONE ? 1 : 0;
  const laughing = t < T_HUSH ? 1 : 0;
  const open = laughing * (0.45 + 0.3 * Math.abs(Math.sin(Math.PI * 2 * (t - T_FIELD)))) + 0.15 * hushed;
  const grin = 1 - 0.3 * SNAPPY(t, T_HUSH) - 0.5 * SNAPPY(t, T_ONE);
  const fear = 0.85 * SNAPPY(t, T_BURN);
  const faceScale = 1.9 * (1 - 0.1 * DEFAULT(t, T_BURN));
  const lookAt = SNAPPY(t, T_HUSH);
  let cam: Cam = {
    x: lerp(P_PLANET[0], 0, arrive),
    y: lerp(P_PLANET[1], 0.22, arrive),
    zoom: logZoom(20, 1, arrive) * (1 + 0.2 * DEFAULT(t, T_ONE)) * lerp(1, 1.18, ease((t - 14.5) / 1.5)),
    roll: lerp(-0.25, 0, arrive) + idle(t, 6, 0.012) + lerp(-0.08, 0.1, ease((t - 14.4) / 1.6)),
  };
  cam = { ...cam, x: cam.x + lerp(-0.06, 0.05, ease((t - 14.4) / 1.6)) };
  const toward = DEFAULT(t, T_ONE) * 0.35;
  cam = { ...cam, x: lerp(cam.x, P_RED[0], toward), y: lerp(cam.y, P_RED[1], toward) };
  const push = ease((t - 17.75) / 0.5);
  cam = { ...cam, x: lerp(cam.x, P_RED[0], push), y: lerp(cam.y, P_RED[1], push), zoom: cam.zoom * lerp(1, 2.2, push) };
  const q = clamp((t - 18.25) / 0.25);
  if (q > 0) {
    cam = { x: P_RED[0], y: P_RED[1], zoom: cam.zoom * Math.exp(2.9 * easeIn(q)), roll: cam.roll - 0.2 * easeIn(q) };
  }
  const red = t < T_ONE ? 0.03 : 1 + 0.6 * pulse(t, T_ONE, 0.2);
  const gold = (hushed ? 0.3 : 1) * (t >= T_ONE ? 0.75 : 1);
  const burn = t > T_BURN ? ease((t - T_BURN) / 0.7) : 0;
  const reach = t < T_CLAW ? 0 : t < T_BURN ? easeOut((t - T_CLAW) / (T_BURN - T_CLAW)) : 1 - 0.3 * ease((t - T_BURN) / 0.8);
  return layer(4, FIELD_FACE + 160 * 400 + CLAW, ease((t - (T_FIELD - 0.05)) / 0.05) * (1 - ease((t - (T_RED - 0.03)) / 0.05)), cam, {
    a: [T_FIELD, FIELD_FACE, pulse(t, T_ONE, 0.5) + 0.6 * pulse(t, T_BURN, 0.4), 0],
    b: [P_PLANET[0], P_PLANET[1], P_RED[0], P_RED[1]],
    c: [red, gold, reach, burn],
    d: [t - T_ONE, hushed ? 0.55 : 1, t - T_BURN, 0],
    face0: [grin, fear, open, 0],
    face1: [idle(t, 8, 0.02), 0.55 + idle(t, 9, 0.015) + 0.03 * open, faceScale, idle(t, 10, 0.03)],
    face2: [lerp(0, 0.03, lookAt), lerp(0, 0.02, lookAt), 0.15 * (hushed ? 0.6 : 1), 0.005],
  });
}

// ---------------------------------------------------------------- world 5: the red mark, the values, the collapse

const MARK_C: readonly [number, number] = [0, 0.36];
const MARK_R = 0.4;
/** Where the Devil cowers: before the values, before the first strike, and swollen behind the mark before the last. x, y, scale, brightness. */
const DEVIL_AT: readonly (readonly [number, number, number, number])[] = [
  [-0.2, -0.62, 0.34, 1],
  [0.22, -0.6, 0.3, 1],
  [0, -0.05, 1.25, 0.4],
];
/** When the Devil moves to each place after the first. */
const DEVIL_MOVES = [B(39.8), B(45.8)] as const;

/** Where a strike from the Devil at `devil` meets the shell: the shell point facing his mouth. */
function shellPoint(devil: readonly [number, number, number, number]): [number, number] {
  const dx = devil[0] - MARK_C[0];
  const dy = devil[1] - 0.2 * devil[2] - MARK_C[1];
  const len = Math.hypot(dx, dy);
  const rs = MARK_R * 1.18;
  return [MARK_C[0] + (dx / len) * rs, MARK_C[1] + (dy / len) * rs];
}

/**
 * The camera's path through the act, one composition per key; it glides
 * between them and never cuts, so every blow lands on a camera in motion.
 */
const SANCTUM_CAMS: readonly (readonly [number, Cam])[] = [
  [B(38), { x: 0.02, y: 0.12, zoom: 1.08, roll: 0.1 }],
  [B(40), { x: 0.08, y: 0.0, zoom: 1.35, roll: -0.18 }],
  [B(43), { x: -0.02, y: 0.3, zoom: 1.0, roll: 0.22 }],
  [B(45.5), { x: 0, y: 0.2, zoom: 0.64, roll: 0 }],
  [B(48.5), { x: -0.05, y: 0.06, zoom: 1.3, roll: -0.2 }],
  [B(51.5), { x: 0, y: 0.28, zoom: 1.15, roll: 0.25 }],
];

function worldSanctum(t: number): Layer {
  const arrive = HEAVY(t, T_RED - 0.04);
  const pick = (field: keyof Cam, start: number): number =>
    keyed(
      t,
      start,
      SANCTUM_CAMS.map(([at, cam]) => [at, cam[field]] as const),
      GLIDE
    );
  let cam: Cam = {
    x: pick('x', 0),
    y: pick('y', 0.05),
    zoom: pick('zoom', 1) * Math.exp(Math.log(0.04) * (1 - arrive)),
    roll: pick('roll', 0) + idle(t, 11, 0.02),
  };
  // the last breath: a push onto the dot from beat 54, snapping in on beat 55, the dot coming to rest where the end card's mark grows
  const inhale = Math.min(1, 0.35 * easeIn((t - (T_LAST - 0.5)) / 0.5) + 0.65 * SNAPPY(t, T_LAST - LEAD));
  const zoomIn = cam.zoom * Math.exp(Math.log(2.6) * inhale);
  cam = { x: lerp(cam.x, MARK_C[0], inhale), y: lerp(cam.y, MARK_C[1] - CLOSE_C[1] / zoomIn, inhale), zoom: zoomIn, roll: cam.roll * (1 - inhale) };
  const click = (Math.PI / 3) * HEAVY(t, T_VALUES[0] + 0.5);
  const turn = (Math.PI / 4) * HEAVY(t, B(38));
  // the collapse opens with a kick: the mark lurches a quarter turn on its cue, then spins up
  const kick = (Math.PI / 5) * SNAPPY(t, T_COLLAPSE - LEAD);
  const spinUp = t > T_COLLAPSE ? 1.5 * (t - T_COLLAPSE) ** 2 : 0;
  const mrot = -0.12 * (t - T_RED) - click - turn - kick - spinUp;
  const breathe = 1 + 0.03 * Math.sin((t - T_RED) * 2.4) + 0.25 * pulse(t, T_COLLAPSE, 0.15);
  const collapse = easeOut((t - T_COLLAPSE) / 1.8);
  const retract = clamp(SNAPPY(t, T_LAST - LEAD));
  const devil = (field: number): number =>
    keyed(
      t,
      DEVIL_AT[0]?.[field] ?? 0,
      DEVIL_MOVES.map((at, index) => [at, DEVIL_AT[index + 1]?.[field] ?? 0] as const),
      DEFAULT
    );
  const strike = (index: number): V4 => {
    const at = T_VALUES[index] ?? 0;
    const s = shellPoint(DEVIL_AT[index + 1] ?? [0, 0, 1, 1]);
    return [s[0], s[1], at, index === 0 ? 0 : 1];
  };
  // the mark gives where each strike lands: squashed along the line of the blow, then rebounding
  let squash: V4 = [0, 1, 0, 0];
  let devilGive = 0;
  T_VALUES.forEach((at, index) => {
    const g = give(t, at);
    if (g !== 0 && Math.abs(g) > Math.abs(squash[2])) {
      const s = shellPoint(DEVIL_AT[index + 1] ?? [0, 0, 1, 1]);
      const dx = s[0] - MARK_C[0];
      const dy = s[1] - MARK_C[1];
      const len = Math.hypot(dx, dy);
      squash = [dx / len, dy / len, 0.3 * g, 0];
    }
    // the Devil is thrown back by his own blow a beat later: squashed, then stretched
    devilGive += 0.35 * give(t, at + 0.08);
  });
  const g = give(t, T_COLLAPSE);
  if (Math.abs(g) > Math.abs(squash[2])) {
    squash = [0, 1, 0.2 * g, 0];
  }
  const recoil = T_VALUES.reduce((sum, at) => sum + pulse(t, at + 0.05, 0.3), 0);
  const swallow = ease((t - (DEVIL_MOVES[1] + 0.2)) / 0.4) * (1 - ease((t - (T_VALUES[1] + 0.3)) / 0.4));
  return layer(5, 100000, ease((t - (T_RED - 0.06)) / 0.06) * (1 - ease((t - (T_FINAL - 0.02)) / 0.04)), cam, {
    a: [MARK_C[0], MARK_C[1], MARK_R, mrot],
    b: [0, 0, -99, 1],
    c: [collapse, retract, breathe * (1 + 0.1 * (1 - arrive)), 1 + 0.8 * inhale],
    d: strike(0),
    e: strike(1),
    f: [0, 0, -99, 1],
    g: squash,
    face0: [0, 1, 0.45 + 0.15 * Math.sin(t * 3) + 0.5 * swallow, pulse(t, 19.8, 0.05)],
    face1: [devil(0) - 0.05 * recoil * Math.sign(devil(0) + 0.001), devil(1) - 0.05 * recoil, devil(2), idle(t, 12, 0.05) + 0.1 * devilGive],
    face2: [0.03, 0.035, devil(3), 0.003 + 0.003 * recoil],
    face3: [pulse(t, 20.9, 0.06), pulse(t, 23.4, 0.06), 0.6, devilGive],
  });
}

// ---------------------------------------------------------------- world 6: the mark on charcoal

const CLOSE_C: readonly [number, number] = [0, 0.42];

function worldClose(t: number): Layer {
  const grow = easeOut((t - T_FINAL) / 0.6);
  // the mark lands big and settles past its size; it clicks a sixth of a turn on the second bell and pulses on the third
  const settle = spring(t, T_FINAL, 1.6, 0.35);
  const click = (Math.PI / 6) * SNAPPY(t, B(57) - LEAD);
  const beat = 0.16 * give(t, B(58) - LEAD);
  const drift = ease((t - T_FINAL) / 2);
  return layer(6, 2500, ease((t - (T_FINAL - 0.02)) / 0.02), { x: 0, y: lerp(-0.06, 0.03, drift), zoom: lerp(0.9, 1.12, drift), roll: lerp(0.06, 0, drift) }, {
    a: [CLOSE_C[0], CLOSE_C[1], 0.21 * (0.6 + 0.4 * settle) * (1 + beat), -1.2 * (1 - settle) - click],
    b: [grow, 1 + 0.5 * pulse(t, T_FINAL, 0.12) + 1.2 * pulse(t, B(58) - LEAD, 0.12), 1, 0],
    f: [ease((t - 28.3) / 0.6), 0, 0, 0],
  });
}

// ---------------------------------------------------------------- the instant

/** The worlds on screen at time t, the one handing over drawn beneath the one arriving. */
export function shotAt(t: number): Shot {
  const layers: Layer[] = [];
  if (t < T_GALAXY + 0.05) layers.push(worldVoid(t));
  if (t > T_GALAXY - 0.1 && t < T_EYE + 0.05) layers.push(worldGalaxy(t));
  if (t > T_EYE - 0.1 && t < T_PLANET + 0.05) layers.push(worldEye(t));
  if (t > T_PLANET - 0.1 && t < T_FIELD + 0.05) layers.push(worldPlanet(t));
  if (t > T_FIELD - 0.1 && t < T_RED + 0.05) layers.push(worldField(t));
  if (t > T_RED - 0.1 && t < T_FINAL + 0.05) layers.push(worldSanctum(t));
  if (t > T_FINAL - 0.05) layers.push(worldClose(t));

  const flash =
    flashAt(t, T_BURST, 0.5) +
    flashAt(t, T_GALAXY, 0.22) +
    flashAt(t, T_EYE, 0.25) +
    flashAt(t, T_CRACK, 0.12, 0.06, 0) +
    flashAt(t, T_DROP, 0.6, 0.08, 0) +
    flashAt(t, T_PLANET, 0.22) +
    flashAt(t, T_FIELD, 0.2) +
    flashAt(t, T_BURN, 0.08, 0.06, 0) +
    flashAt(t, T_RED, 0.25) +
    T_VALUES.reduce((sum, at) => sum + flashAt(t, at, 0.04, 0.08, 0), 0) +
    flashAt(t, T_COLLAPSE, 0.05, 0.06, 0) +
    flashAt(t, T_FINAL, 0.1, 0.07, 0);
  const tintOf = (): [number, number, number] => {
    if (t < T_BURST) return [1.0, 0.85, 0.62];
    if (t < T_GALAXY) return [1.0, 0.86, 0.66];
    if (t < T_EYE) return [0.8, 0.62, 1.0];
    if (t < T_CRACK - 0.1) return [0.62, 0.95, 1.0];
    if (t < T_DROP - 0.1) return [0.85, 0.5, 1.0];
    if (t < T_PLANET) return [0.9, 0.72, 1.0];
    if (t < T_FIELD) return [0.72, 1.0, 0.8];
    if (t < T_BURN - 0.1) return [1.0, 0.82, 0.45];
    if (t < T_RED) return [1.0, 0.95, 0.8];
    if (t < T_FINAL) return [0.85, 0.9, 1.0];
    return [0.95, 0.9, 0.85];
  };
  const tint = tintOf();
  const inhale = t >= T_INHALE && t < T_DROP ? SNAPPY(t, T_INHALE) : 0;
  const gather = t >= T_GATHER - LEAD && t < T_DROP ? Math.min(1, SNAPPY(t, T_GATHER - LEAD)) : 0;
  const last = t >= T_LAST - LEAD && t < T_FINAL ? Math.min(1, SNAPPY(t, T_LAST - LEAD)) : 0;
  const impacts = pulse(t, T_BURST, 0.12) + pulse(t, T_DROP, 0.2) * 1.2 + pulse(t, T_ONE, 0.15) * 0.5;
  let sh = addShake(shake(t, T_BURST, 7, 0.18), shake(t, T_DROP, 12, 0.22));
  sh = addShake(sh, shake(t, T_ONE, 6, 0.18));
  sh = addShake(sh, shake(t, T_CRACK, 4, 0.12));
  sh = addShake(sh, shake(t, T_GATHER, 3, 0.1));
  const closing = t >= T_FINAL ? 1 : 0;
  return {
    layers,
    finish: {
      exposure: (1 - 0.25 * gather) * (1 - 0.7 * inhale) * (1 - 0.55 * last),
      flash: [tint[0], tint[1], tint[2], flash],
      bloom: closing ? 0.2 : 0.45,
      aberration: Math.min(0.7, impacts),
      vignette: closing ? 0.12 : 0.4,
      direct: closing,
      tint: [1, 1, 1],
      shake: sh,
    },
  };
}
