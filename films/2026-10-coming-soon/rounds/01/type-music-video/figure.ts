import { P, clamp, lerp } from './kit.js';
import { fontOf, metricAt } from './type.js';

import type { G } from './kit.js';
import type { Ctx } from './type.js';

/** A point relative to her feet, in units of her letter size; y runs down, so up is negative. */
export type Pt = readonly [number, number];

/**
 * Her pose. She is built from letters: a Q for her head, an A for her coat,
 * an l for each arm and an L for each leg. Hands and feet are targets; each
 * limb letter turns and stretches to reach its target from its joint.
 */
export interface Pose {
  /** Her hips' height above her feet; standing is {@link HIP}. */
  hipY: number;
  /** The coat's lean about the hips, in radians. */
  lean: number;
  /** The head's tilt, in radians. */
  head: number;
  handL: Pt;
  handR: Pt;
  footL: Pt;
  footR: Pt;
  /** Squash (positive) or stretch (negative) about the feet. */
  squash: number;
  /** What the right hand holds. */
  holds?: { ch: string; color: string; size: number } | null;
  /** Her face, drawn in the Q's bowl; absent is a calm face. */
  face?: Face;
  /** Seen from behind: the bowl is her hair and there is no face. */
  back?: boolean;
}

/**
 * A face made of glyphs inside the Q's bowl: eyes (dots, o's when wide, carets
 * when happy, dashes when shut, chevrons when wincing), dash brows that tilt
 * (negative worried, positive set), and a mouth (a dash, a turned parenthesis
 * for a smile or frown, a tilde, an o).
 */
export interface Face {
  eyes: 'dot' | 'wide' | 'happy' | 'shut' | 'wince';
  mouth: 'flat' | 'smile' | 'frown' | 'wavy' | 'o';
  brow: number;
  /** Where the eyes look, each from -1 to 1. */
  look: Pt;
  /** Brows raised, 0 to 1. */
  raise?: number;
}

export const CALM: Face = { eyes: 'dot', mouth: 'flat', brow: 0, look: [0, 0] };

const HIP = 0.42;

export const STAND: Pose = {
  hipY: HIP,
  lean: 0,
  head: 0,
  handL: [-0.36, -0.44],
  handR: [0.36, -0.46],
  footL: [-0.15, 0],
  footR: [0.15, 0],
  squash: 0,
};

/** Both hands at her chest round the phone, the right one higher, thumb working. */
export const PHONE: Pose = {
  ...STAND,
  head: 0.16,
  handL: [-0.04, -0.62],
  handR: [0.1, -0.7],
};

/** Her cheer: one arm straight up, the other flung out and up, never a mirrored V. */
export const ARMS_UP: Pose = {
  ...STAND,
  head: -0.15,
  lean: -0.06,
  handL: [-0.45, -1.52],
  handR: [0.7, -1.1],
  squash: -0.05,
  face: { eyes: 'happy', mouth: 'smile', brow: -0.2, look: [0, -0.4], raise: 0.6 },
};

export const LOOK_UP: Pose = {
  ...STAND,
  head: -0.3,
  handL: [-0.32, -0.42],
  handR: [0.4, -0.5],
};

export const SIT: Pose = {
  ...STAND,
  hipY: 0.16,
  lean: -0.06,
  head: 0.22,
  footL: [-0.46, 0],
  footR: [0.44, -0.02],
  handL: [-0.3, -0.28],
  handR: [0.1, -0.56],
};

export function blend(a: Pose, b: Pose, u: number): Pose {
  const t = clamp(u, -0.5, 1.5);
  const pt = (p: Pt, q: Pt): Pt => [lerp(p[0], q[0], t), lerp(p[1], q[1], t)];
  return {
    hipY: lerp(a.hipY, b.hipY, t),
    lean: lerp(a.lean, b.lean, t),
    head: lerp(a.head, b.head, t),
    handL: pt(a.handL, b.handL),
    handR: pt(a.handR, b.handR),
    footL: pt(a.footL, b.footL),
    footR: pt(a.footR, b.footR),
    squash: lerp(a.squash, b.squash, t),
    holds: t < 0.5 ? (a.holds ?? null) : (b.holds ?? null),
    face: blendFace(a.face ?? CALM, b.face ?? CALM, t),
    back: (t < 0.5 ? a.back : b.back) ?? false,
  };
}

function blendFace(a: Face, b: Face, t: number): Face {
  const pick = t < 0.5 ? a : b;
  return {
    ...pick,
    brow: lerp(a.brow, b.brow, clamp(t)),
    look: [lerp(a.look[0], b.look[0], clamp(t)), lerp(a.look[1], b.look[1], clamp(t))],
    raise: lerp(a.raise ?? 0, b.raise ?? 0, clamp(t)),
  };
}

/** A walk cycle at `phase` (radians): feet swing on arcs, the coat bobs and the arms counter-swing. */
export function walk(phase: number): Pose {
  const s = Math.sin(phase);
  const lift = (p: number): number => -Math.max(0, Math.cos(p)) * 0.1;
  return {
    ...STAND,
    hipY: HIP - 0.03 * Math.abs(Math.cos(phase)),
    lean: 0.05,
    footL: [-0.08 + 0.18 * s, lift(phase)],
    footR: [0.08 - 0.18 * s, lift(phase + Math.PI)],
    handL: [-0.32 - 0.14 * s, -0.44],
    handR: [0.32 + 0.1 * s, -0.46],
  };
}

const LEG = 0.62;
const COAT = 0.98;
const ARM = 0.72;
const HEAD = 0.66;

/**
 * A limb letter in pixels from a joint to a target: its stem's top on the
 * joint, turned to point at the target and stretched to reach it. `mirror`
 * flips it, so an L can point its foot either way; `stem` is where across the
 * letter's ink its stem stands, 0 at its left edge.
 */
function limb(g: G, ctx: Ctx, ch: string, size: number, weight: number, color: string, from: Pt, to: Pt, mirror: boolean, stem: number): void {
  const m = metricAt(g, ctx, 'sans', weight, false, ch, size);
  const natural = m.ascent + m.descent;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.max(1, Math.hypot(dx, dy));
  g.save();
  g.translate(from[0], from[1]);
  g.rotate(Math.atan2(-dx, dy));
  g.scale(mirror ? -1 : 1, length / natural);
  g.font = fontOf(ctx, 'sans', weight, size);
  g.fillStyle = color;
  g.fillText(ch, m.left - (m.left + m.right) * stem, m.ascent);
  g.restore();
}

export interface FigureLook {
  coat?: string;
  skin?: string;
  legs?: string;
  /** The face's fill, its features' ink, and the hair seen from behind. */
  face?: string;
  ink?: string;
  hair?: string;
}

/** One feature of the face: a glyph centred on its point, at a size relative to the bowl. */
function feature(g: G, ctx: Ctx, ch: string, x: number, y: number, size: number, ink: string, rot = 0, weight = 800): void {
  const m = metricAt(g, ctx, 'sans', weight, false, ch, size);
  g.save();
  g.translate(x, y);
  if (rot !== 0) {
    g.rotate(rot);
  }
  g.font = fontOf(ctx, 'sans', weight, size);
  g.fillStyle = ink;
  g.fillText(ch, -(m.right - m.left) / 2, (m.ascent - m.descent) / 2);
  g.restore();
}

/** The face in a bowl of radius r centred on (x, y). */
function drawFace(g: G, ctx: Ctx, x: number, y: number, r: number, f: Face, ink: string): void {
  const lx = f.look[0] * 0.16 * r;
  const ly = f.look[1] * 0.12 * r;
  const raise = (f.raise ?? 0) * 0.1 * r;
  for (const side of [-1, 1]) {
    const ex = x + side * 0.36 * r + lx;
    const ey = y - 0.06 * r + ly;
    switch (f.eyes) {
      case 'dot':
        feature(g, ctx, '.', ex, ey - 0.12 * r, 1.5 * r, ink);
        break;
      case 'wide':
        feature(g, ctx, 'o', ex, ey, 0.6 * r, ink, 0, 700);
        break;
      case 'happy':
        feature(g, ctx, '^', ex, ey + 0.08 * r, 0.8 * r, ink);
        break;
      case 'shut':
        feature(g, ctx, '-', ex, ey, 0.6 * r, ink);
        break;
      case 'wince':
        feature(g, ctx, side < 0 ? '>' : '<', ex, ey, 0.6 * r, ink);
        break;
    }
    // A brow: a dash over each eye, its inner end up when worried and down when set.
    feature(g, ctx, '-', x + side * 0.38 * r + lx * 0.5, y - 0.46 * r - raise, 0.62 * r, ink, side * -0.5 * f.brow);
  }
  const mx = x + lx * 0.6;
  const my = y + 0.44 * r + ly * 0.4;
  switch (f.mouth) {
    case 'flat':
      feature(g, ctx, '-', mx, my, 0.66 * r, ink);
      break;
    case 'smile':
      feature(g, ctx, ')', mx, my - 0.06 * r, 0.8 * r, ink, Math.PI / 2);
      break;
    case 'frown':
      feature(g, ctx, '(', mx, my + 0.06 * r, 0.7 * r, ink, Math.PI / 2);
      break;
    case 'wavy':
      feature(g, ctx, '~', mx, my, 0.66 * r, ink);
      break;
    case 'o':
      feature(g, ctx, 'o', mx, my, 0.5 * r, ink, 0, 700);
      break;
  }
}

/** A blink: the eyes shut for four frames every few seconds, each figure on its own phase. */
export function blinking(face: Face, time: number, phase = 0): Face {
  if (face.eyes !== 'dot' && face.eyes !== 'wide') {
    return face;
  }
  const t = (time + phase) % 170;
  return t >= 0 && t < 4 ? { ...face, eyes: 'shut' } : face;
}

/**
 * Her, standing on (x, y), `s` pixels a letter unit (she is about 1.5 units
 * tall). The legs hang from the hips, the coat sits on them, the head sits on
 * the coat's apex, and the arms hang from its shoulders over it; an arm raised
 * above her neck passes behind her head, so it never crosses her face.
 */
export function figure(g: G, ctx: Ctx, x: number, y: number, s: number, pose: Pose, look: FigureLook = {}): void {
  const coatColor = look.coat ?? P.coat;
  const skin = look.skin ?? P.skin;
  const legColor = look.legs ?? P.legs;
  g.save();
  g.translate(x, y);
  g.scale(1 + pose.squash * 0.6, 1 - pose.squash);
  const px = (p: Pt): Pt => [p[0] * s, p[1] * s];
  const hip: Pt = [0, -pose.hipY * s];
  limb(g, ctx, 'L', LEG * s, 800, legColor, [hip[0] - 0.08 * s, hip[1]], px(pose.footL), true, 0.12);
  limb(g, ctx, 'L', LEG * s, 800, legColor, [hip[0] + 0.08 * s, hip[1]], px(pose.footR), false, 0.12);
  const coat = metricAt(g, ctx, 'sans', 900, false, 'A', COAT * s);
  const coatH = coat.ascent;
  const coatBottom = hip[1] + 0.06 * s;
  // The coat's frame: origin at the middle of its hem, leaning about the hips.
  const c = Math.cos(pose.lean);
  const sn = Math.sin(pose.lean);
  const fromCoat = (ux: number, uy: number): Pt => [hip[0] + ux * c - (uy + coatBottom - hip[1]) * sn, hip[1] + ux * sn + (uy + coatBottom - hip[1]) * c];
  g.save();
  g.translate(hip[0], hip[1]);
  g.rotate(pose.lean);
  g.translate(0, coatBottom - hip[1]);
  g.font = fontOf(ctx, 'sans', 900, COAT * s);
  g.fillStyle = coatColor;
  g.fillText('A', -(coat.right - coat.left) / 2, 0);
  g.restore();
  const shoulderL = fromCoat(-0.07 * s, -coatH + 0.12 * s);
  const shoulderR = fromCoat(0.07 * s, -coatH + 0.12 * s);
  const neck = fromCoat(0, -coatH + 0.04 * s);
  const arms: readonly (readonly [Pt, Pt, boolean])[] = [
    [shoulderL, px(pose.handL), false],
    [shoulderR, px(pose.handR), true],
  ];
  const raised = ([, hand]: readonly [Pt, Pt, boolean]): boolean => hand[1] < neck[1];
  for (const [from, to, mirror] of arms.filter(raised)) {
    limb(g, ctx, 'l', ARM * s, 700, skin, from, to, mirror, 0.5);
  }
  const head = metricAt(g, ctx, 'sans', 800, false, 'Q', HEAD * s);
  g.save();
  g.translate(neck[0], neck[1]);
  g.rotate(pose.head + pose.lean);
  // The bowl of the Q, the O inside it: the face is drawn there, under the ring.
  const bowl = metricAt(g, ctx, 'sans', 800, false, 'O', HEAD * s);
  const bx = -(head.right + head.left) / 2 + (bowl.left + bowl.right) / 2;
  const by = -0.02 * s - (bowl.ascent - bowl.descent) / 2;
  const r = ((bowl.left + bowl.right) / 2) * 0.66;
  g.fillStyle = pose.back === true ? (look.hair ?? '#4a2f3a') : (look.face ?? '#ffe6cf');
  g.beginPath();
  g.arc(bx, by, r * 1.08, 0, Math.PI * 2);
  g.fill();
  if (pose.back !== true) {
    drawFace(g, ctx, bx, by, r, pose.face ?? CALM, look.ink ?? '#2b2140');
  }
  g.font = fontOf(ctx, 'sans', 800, HEAD * s);
  g.fillStyle = skin;
  // The Q's bowl sits on the coat's apex; its tail is the hair at her nape.
  g.fillText('Q', -(head.right - head.left) / 2, -0.02 * s);
  g.restore();
  for (const [from, to, mirror] of arms.filter((arm) => !raised(arm))) {
    limb(g, ctx, 'l', ARM * s, 700, skin, from, to, mirror, 0.5);
  }
  if (pose.holds !== undefined && pose.holds !== null) {
    const hold = pose.holds;
    const hm = metricAt(g, ctx, 'sans', 900, false, hold.ch, hold.size * s);
    g.font = fontOf(ctx, 'sans', 900, hold.size * s);
    g.fillStyle = hold.color;
    const h = px(pose.handR);
    g.fillText(hold.ch, h[0] - (hm.right - hm.left) / 2, h[1] + (hm.ascent - hm.descent) / 2);
  }
  g.restore();
}

/** Where her right hand is, in the space she was drawn in. */
export function handOf(x: number, y: number, s: number, pose: Pose): { x: number; y: number } {
  return { x: x + pose.handR[0] * s, y: y + pose.handR[1] * s };
}
