import { clamp, lerp } from './motion.js';
import { BRIM, BRIM_DARK, BRIM_LIGHT, FEATURE, HORN, HORN_TIP, SCLERA, SWEAT } from './palette.js';

/** Everything the Devil's head can do, each 0 at rest. */
export interface DevilPose {
  x: number;
  y: number;
  /** Head radius in pixels. */
  r: number;
  rot: number;
  /** Squash and stretch: horizontal and vertical scale. */
  sx: number;
  sy: number;
  /** -1 terror … 0 neutral … 1 wicked delight. */
  mood: number;
  /** 0 closed … 1 laughing wide … 1.5 gaping. */
  mouth: number;
  /** Where the pupils look, each axis in -1..1. */
  lookX: number;
  lookY: number;
  /** Each lid, 0 open … 1 shut. */
  lidL: number;
  lidR: number;
  /** Horn growth 0..1 and droop 0..1, left and right apart so they never twin. */
  hornL: number;
  hornR: number;
  droopL: number;
  droopR: number;
  /** How far the face's features have formed, 0..1. */
  features: number;
  sweat: number;
  /** The instant, for the idle parts (sweat, the grimace's wobble). */
  t: number;
  /** The mouth's grin drawn, 0..1: 0 leaves the mouth blank. */
  grin: number;
  /** The goatee's swing about the chin, radians: it trails the head. */
  chinSway: number;
}

export const REST: DevilPose = {
  x: 540,
  y: 960,
  r: 200,
  rot: 0,
  sx: 1,
  sy: 1,
  mood: 1,
  mouth: 0,
  lookX: 0,
  lookY: 0,
  lidL: 0,
  lidR: 0,
  hornL: 1,
  hornR: 1,
  droopL: 0,
  droopR: 0,
  features: 1,
  sweat: 0,
  t: 0,
  grin: 1,
  chinSway: 0,
};

type P = CanvasRenderingContext2D;

/** The head's outline, in head units (radius 1), pointed at the chin. */
function headPath(g: P, wobble: (i: number) => number): void {
  const n = 56;
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const s = Math.sin(a);
    const c = Math.cos(a);
    const chin = Math.max(0, s) ** 7 * 0.34;
    const brow = Math.max(0, -s) ** 2 * -0.05;
    const cheek = 1 + 0.05 * Math.max(0, s) * (1 - Math.max(0, s) ** 4);
    const k = 1 + wobble(i % n);
    const px = c * 1.04 * cheek * k;
    const py = (s * 0.94 + chin + brow) * k;
    if (i === 0) {
      g.moveTo(px, py);
    } else {
      g.lineTo(px, py);
    }
  }
  g.closePath();
}

/** One horn, in head units: rooted on the crown at `side` (-1 left, 1 right), curving out then up. */
function horn(g: P, side: number, grow: number, droop: number): void {
  if (grow <= 0.001) {
    return;
  }
  const bx = side * 0.52;
  const by = -0.74;
  const len = 0.95 * grow;
  const up = -Math.PI / 2 + side * (0.62 + droop * 1.9);
  const tx = bx + Math.cos(up) * len + side * 0.22 * grow;
  const ty = by + Math.sin(up) * len;
  const cx = bx + side * 0.46 * grow;
  const cy = by - 0.18 * grow;
  const n = 12;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const v = 1 - u;
    const px = v * v * bx + 2 * v * u * cx + u * u * tx;
    const py = v * v * by + 2 * v * u * cy + u * u * ty;
    const dx = 2 * v * (cx - bx) + 2 * u * (tx - cx);
    const dy = 2 * v * (cy - by) + 2 * u * (ty - cy);
    const d = Math.hypot(dx, dy) || 1;
    const w = 0.2 * (1 - u) ** 0.9 * Math.min(1, grow * 1.6);
    left.push([px - (dy / d) * w, py + (dx / d) * w]);
    right.push([px + (dy / d) * w, py - (dx / d) * w]);
  }
  g.beginPath();
  g.moveTo(left[0]![0], left[0]![1]);
  for (const [px, py] of left) {
    g.lineTo(px, py);
  }
  for (let i = right.length - 1; i >= 0; i--) {
    g.lineTo(right[i]![0], right[i]![1]);
  }
  g.closePath();
  const grad = g.createLinearGradient(bx, by, tx, ty);
  grad.addColorStop(0, HORN);
  grad.addColorStop(1, HORN_TIP);
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 0.035;
  g.strokeStyle = FEATURE;
  g.lineJoin = 'round';
  g.stroke();
  // ridges across the horn
  g.lineWidth = 0.022;
  for (let i = 1; i < 4; i++) {
    const u = i / 4.6;
    const a = left[Math.round(u * n)]!;
    const b = right[Math.round(u * n)]!;
    g.beginPath();
    g.moveTo(a[0], a[1]);
    g.quadraticCurveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.03, b[0], b[1]);
    g.stroke();
  }
}

/** An eye, in head units, at `side`; its shape runs from a narrow wicked almond (mood 1) to a round stare (mood -1). */
function eye(g: P, pose: DevilPose, side: number, lid: number): void {
  const f = pose.features;
  const terror = clamp(-pose.mood);
  const delight = clamp(pose.mood);
  const ex = side * 0.37;
  const ey = -0.12 - terror * 0.04;
  const w = lerp(0.2, 0.22, terror) * f;
  const hOpen = lerp(0.1, 0.19, terror) * lerp(1, 0.7, delight);
  const h = hOpen * (1 - clamp(lid)) * f;
  if (w <= 0.002) {
    return;
  }
  const tilt = side * lerp(0.28, -0.12, terror) * delight + side * -0.1 * terror;
  g.save();
  g.translate(ex, ey);
  g.rotate(tilt);
  g.beginPath();
  g.moveTo(-w, 0);
  g.bezierCurveTo(-w * 0.5, -h * 1.35, w * 0.5, -h * 1.35, w, 0);
  g.bezierCurveTo(w * 0.5, h * 1.35, -w * 0.5, h * 1.35, -w, 0);
  g.closePath();
  g.fillStyle = SCLERA;
  g.fill();
  g.lineWidth = 0.028;
  g.strokeStyle = FEATURE;
  g.stroke();
  if (h > 0.01) {
    g.save();
    g.clip();
    const px = pose.lookX * w * 0.45;
    const py = pose.lookY * h * 0.5;
    const pw = lerp(0.028, 0.06, terror);
    const ph = lerp(0.1, 0.06, terror);
    g.beginPath();
    g.ellipse(px, py, pw, ph, 0, 0, Math.PI * 2);
    g.fillStyle = FEATURE;
    g.fill();
    g.beginPath();
    g.arc(px + pw * 0.4, py - ph * 0.45, 0.018, 0, Math.PI * 2);
    g.fillStyle = SCLERA;
    g.fill();
    g.restore();
  }
  g.restore();
  // the brow: a wedge slanting down to the nose in delight, up to it in terror
  const inner = lerp(0.07, -0.13, terror) * f + delight * 0.03;
  const outer = lerp(-0.06, 0.02, terror) * f;
  const by = ey - lerp(0.13, 0.22, terror);
  g.beginPath();
  g.moveTo(side * 0.14, by + inner);
  g.lineTo(side * 0.6, by + outer - 0.05);
  g.lineTo(side * 0.58, by + outer + 0.02);
  g.lineTo(side * 0.15, by + inner + 0.075 * f);
  g.closePath();
  g.fillStyle = FEATURE;
  g.fill();
}

/** The mouth's upper and lower edges at x in -1..1, blended from grin (mood 1) to clenched grimace (mood -1). */
function mouthEdges(pose: DevilPose, x: number): [number, number] {
  const delight = clamp(pose.mood);
  const terror = clamp(-pose.mood);
  const open = pose.mouth;
  const gTop = 0.3 - 0.2 * x * x;
  const gBot = gTop + (0.035 + (0.1 + open * 0.34) * (1 - x * x)) * pose.grin;
  const wav = 0.018 * Math.sin(x * 11 + pose.t * 0.9);
  const fTop = 0.36 + wav;
  const edge = (1 - x ** 8) ** 0.5;
  const fBot = fTop + (0.12 + open * 0.2) * edge;
  const nTop = 0.34;
  const nBot = nTop + (0.02 + open * 0.3) * (1 - x * x);
  const top = delight > 0 ? lerp(nTop, gTop, delight) : lerp(nTop, fTop, terror);
  const bot = delight > 0 ? lerp(nBot, gBot, delight) : lerp(nBot, fBot, terror);
  return [top, bot];
}

function mouth(g: P, pose: DevilPose): void {
  const f = pose.features;
  if (f <= 0.01) {
    return;
  }
  const delight = clamp(pose.mood);
  const terror = clamp(-pose.mood);
  const half = lerp(lerp(0.3, 0.6, delight), 0.36, terror) * f;
  const n = 24;
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const x = -1 + (2 * i) / n;
    const [top] = mouthEdges(pose, x);
    if (i === 0) {
      g.moveTo(x * half, top);
    } else {
      g.lineTo(x * half, top);
    }
  }
  for (let i = n; i >= 0; i--) {
    const x = -1 + (2 * i) / n;
    const [, bot] = mouthEdges(pose, x);
    g.lineTo(x * half, bot);
  }
  g.closePath();
  g.fillStyle = FEATURE;
  g.fill();
  g.save();
  g.clip();
  // teeth: a hanging row in the grin, a clenched block in the grimace
  g.fillStyle = SCLERA;
  const teeth = 9;
  for (let i = 0; i < teeth; i++) {
    const x0 = -1 + (2 * i) / teeth;
    const x1 = -1 + (2 * (i + 1)) / teeth;
    const xm = (x0 + x1) / 2;
    const [top] = mouthEdges(pose, xm);
    const depth = lerp(0.075, 0.2, terror);
    g.beginPath();
    g.moveTo(x0 * half, top - 0.05);
    g.lineTo(x1 * half, top - 0.05);
    g.lineTo(x1 * half, top + depth * 0.55);
    g.lineTo(xm * half, top + depth);
    g.lineTo(x0 * half, top + depth * 0.55);
    g.closePath();
    g.fill();
  }
  if (terror > 0.05) {
    for (let i = 0; i < teeth; i++) {
      const x0 = -1 + (2 * i) / teeth;
      const x1 = -1 + (2 * (i + 1)) / teeth;
      const xm = (x0 + x1) / 2;
      const [, bot] = mouthEdges(pose, xm);
      const depth = 0.1 * terror;
      g.beginPath();
      g.moveTo(x0 * half, bot + 0.05);
      g.lineTo(x1 * half, bot + 0.05);
      g.lineTo(x1 * half, bot - depth * 0.55);
      g.lineTo(xm * half, bot - depth);
      g.lineTo(x0 * half, bot - depth * 0.55);
      g.closePath();
      g.fill();
    }
  }
  g.restore();
}

/** Draws the Devil's head at its pose. */
export function drawDevil(g: P, pose: DevilPose, boil: (i: number) => number): void {
  g.save();
  g.translate(pose.x, pose.y);
  g.rotate(pose.rot);
  g.scale(pose.r * pose.sx, pose.r * pose.sy);
  horn(g, -1, pose.hornL, pose.droopL);
  horn(g, 1, pose.hornR, pose.droopR);
  // the head: shadow tone, then the lit face offset up-left, so a crescent of shade stays
  headPath(g, boil);
  g.fillStyle = BRIM_DARK;
  g.fill();
  g.save();
  g.clip();
  g.save();
  g.translate(-0.07, -0.06);
  g.scale(0.97, 0.97);
  headPath(g, boil);
  g.fillStyle = BRIM;
  g.fill();
  g.restore();
  g.beginPath();
  g.ellipse(-0.38, -0.5, 0.26, 0.13, -0.5, 0, Math.PI * 2);
  g.fillStyle = BRIM_LIGHT;
  g.globalAlpha = 0.55;
  g.fill();
  g.globalAlpha = 1;
  g.restore();
  // goatee
  const f = pose.features;
  if (f > 0.02) {
    g.save();
    g.translate(0, 1.08);
    g.rotate(pose.chinSway);
    g.translate(0, -1.08);
    g.beginPath();
    g.moveTo(-0.1 * f, 1.08);
    g.quadraticCurveTo(0, 1.2 + 0.2 * f, 0.03 * f, 1.42 * f + 1.08 * (1 - f));
    g.quadraticCurveTo(0.02, 1.2, 0.1 * f, 1.08);
    g.closePath();
    g.fillStyle = FEATURE;
    g.fill();
    g.restore();
  }
  eye(g, pose, -1, pose.lidL);
  eye(g, pose, 1, pose.lidR);
  mouth(g, pose);
  if (pose.sweat > 0.01) {
    for (let k = 0; k < 2; k++) {
      const phase = (pose.t * (0.018 + k * 0.007) + k * 0.43) % 1;
      const sxp = (k === 0 ? 0.78 : -0.72) + phase * 0.05;
      const syp = -0.45 + phase * 0.7;
      const s = 0.1 * clamp(pose.sweat * 3) * (1 - phase * 0.3);
      g.beginPath();
      g.moveTo(sxp, syp - s * 1.6);
      g.bezierCurveTo(sxp + s, syp - s * 0.2, sxp + s, syp + s, sxp, syp + s);
      g.bezierCurveTo(sxp - s, syp + s, sxp - s, syp - s * 0.2, sxp, syp - s * 1.6);
      g.fillStyle = SWEAT;
      g.fill();
      g.lineWidth = 0.02;
      g.strokeStyle = FEATURE;
      g.stroke();
    }
  }
  g.restore();
}
