// The search, the film's set piece, after round 1's origin-flight field: the Devil's collection
// is a vast field of gold marks, every AI company, each one different. Asked "All of them?", his
// eyes throw two searchlights across it and the camera flies through the field after them: mark
// after mark flares and takes his brand, faster and faster, until the whole field burns gold and
// one slot stays dark. The camera rushes it in silence; on the drop it lights Signal Red, the
// HushBox mark, drawn from the logo's own parts and resting exact, and a shockwave blows his
// field apart. He reaches for it and it burns him.
import { drawClaw } from './claw.js';
import { drawDevil } from './devil.js';
import { drawEmber } from './fire.js';
import { CX, H, INK, SNAPPY, W, bf, clamp, env, hash, lerp, mix, prog, rgba, smooth, springOf } from './kit.js';
import { FLARE_BEATS } from './score.js';
import { tip } from './scenes-hook.js';
import { brandPalette, markAtRest } from './scenes-hush.js';
import { field } from './scenes-praise.js';

import type { G } from './kit.js';
import type { LookContext } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

const TAU = Math.PI * 2;

/** The one slot in the field that is HushBox's: its centre and the logo's drawn width. */
export const HUSH_SLOT = { x: 640, y: 1180, size: 96 };
/** The slot's clear margin: no gold mark is drawn inside the logo's box and this border. */
const CLEAR = 70;

/** The search's beats: the question, the pull out, the dive, two whips, the field ablaze, the rush, the silence. */
const ASK = bf(35);
const ABLAZE = bf(39);
const RUSH = bf(39.5);
const HUSH = bf(40.5);
/** The drop: the slot lights Signal Red. */
export const LIT_BEAT = 41;
const LIT = bf(LIT_BEAT);
const REACH = bf(42.5);
const BURN = bf(43);


/** Each flare's region centre, in field coordinates: the dive (36), the first whip (37), the second whip (38). */
function regionOf(beat: number): [number, number] {
  return beat < 37 ? [300, 820] : beat < 38 ? [840, 1480] : [260, 1640];
}

interface Mark {
  x: number;
  y: number;
  r: number;
  arms: number;
  tilt: number;
  spin: number;
  curl: number;
  depth: number;
  /** Parallax: how much faster than the field this mark moves under the camera. */
  layer: number;
  /** A mark outside the field the laugh lands on: it fades in as the camera pulls out. */
  extra: boolean;
}

/** Whether a field position falls in the HushBox slot's clear box. */
function inSlot(x: number, y: number): boolean {
  const half = HUSH_SLOT.size / 2 + CLEAR;
  return Math.abs(x - HUSH_SLOT.x) < half && Math.abs(y - HUSH_SLOT.y) < half;
}

function markAt(i: number, x: number, y: number, extra: boolean): Mark {
  const l = hash(i, 10);
  return {
    x,
    y,
    r: 14 + 18 * hash(i, 3),
    arms: 3 + Math.floor(hash(i, 4) * 5),
    tilt: hash(i, 5) * TAU,
    spin: (hash(i, 6) < 0.5 ? -1 : 1) * (0.008 + 0.02 * hash(i, 7)),
    curl: 0.8 + 1.2 * hash(i, 8),
    depth: 0.55 + 0.45 * hash(i, 9),
    layer: l < 0.3 ? 0.78 : l < 0.75 ? 1 : 1.28,
    extra,
  };
}

/** The field the laugh lands on: hundreds of gold marks on a jittered grid below the copy. */
const SPIRALS: readonly Mark[] = (() => {
  const out: Mark[] = [];
  const cols = 11;
  const rows = 16;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const x = 30 + ((col + 0.5 + (hash(i, 1) - 0.5) * 0.8) / cols) * 1020;
      const y = 500 + ((row + 0.5 + (hash(i, 2) - 0.5) * 0.8) / rows) * 1380;
      if (!inSlot(x, y)) {
        out.push(markAt(i, x, y, false));
      }
    }
  }
  return out;
})();

/** The field beyond it, which the pull out reveals: the collection is far larger than the frame. */
const EXTRAS: readonly Mark[] = (() => {
  const out: Mark[] = [];
  const cols = 16;
  const rows = 20;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = 1000 + row * cols + col;
      const x = -760 + ((col + 0.5 + (hash(i, 1) - 0.5) * 0.8) / cols) * 2600;
      const y = -160 + ((row + 0.5 + (hash(i, 2) - 0.5) * 0.8) / rows) * 2900;
      const inside = x > 0 && x < 1080 && y > 470 && y < 1910;
      if (!inside) {
        out.push(markAt(i, x, y, true));
      }
    }
  }
  return out;
})();

const MARKS: readonly Mark[] = [...EXTRAS, ...SPIRALS];

/** Where the laugh's halo demon `slot` lands in the field: slot 0 is the gap, HushBox's slot. */
export function fieldTarget(slot: number): [number, number] {
  if (slot === 0) {
    return [HUSH_SLOT.x, HUSH_SLOT.y];
  }
  const s = SPIRALS[(slot * 13) % SPIRALS.length];
  return s === undefined ? [CX, 1100] : [s.x, s.y];
}

/** The mark each flare lands on: the field mark nearest a point circling the region's centre. */
const FLARE_TARGETS: readonly [number, number][] = FLARE_BEATS.map((beat, j) => {
  const [rx, ry] = regionOf(beat);
  const a = j * 2.4;
  const d = 60 + 40 * (j % 3);
  const px = rx + Math.cos(a) * d;
  const py = ry + Math.sin(a) * d;
  let best: Mark | undefined;
  for (const m of SPIRALS) {
    if (best === undefined || Math.hypot(m.x - px, m.y - py) < Math.hypot(best.x - px, best.y - py)) {
      best = m;
    }
  }
  return best === undefined ? [px, py] : [best.x, best.y];
});

/** The frame each mark takes his brand: the first flare that reaches it, or the wave that sets the whole field alight on 39. */
const BRANDED: readonly number[] = MARKS.map((m) => {
  let at = Number.POSITIVE_INFINITY;
  FLARE_BEATS.forEach((beat, j) => {
    const target = FLARE_TARGETS[j];
    if (target !== undefined && Math.hypot(m.x - target[0], m.y - target[1]) < 110) {
      at = Math.min(at, bf(beat));
    }
  });
  const wave = ABLAZE + Math.round((22 * Math.hypot(m.x - 560, m.y - 1180)) / 1900);
  return Math.min(at, wave);
});

interface Cam {
  x: number;
  y: number;
  z: number;
}

/** The camera's moves through the field: each flies from where the last left it, zoom in log space. */
const MOVES: readonly { at: number; beats: number; to: Cam; ease: (u: number) => number }[] = [
  { at: 35.25, beats: 0.75, to: { x: 540, y: 1250, z: 0.5 }, ease: smooth },
  { at: 36, beats: 0.6, to: { x: 300, y: 820, z: 2 }, ease: (u) => 1 - (1 - u) ** 3 },
  { at: 37, beats: 0.3, to: { x: 840, y: 1480, z: 2.6 }, ease: (u) => 1 - (1 - u) ** 3 },
  { at: 38, beats: 0.25, to: { x: 260, y: 1640, z: 3.1 }, ease: (u) => 1 - (1 - u) ** 3 },
  { at: 39, beats: 0.3, to: { x: 560, y: 1180, z: 0.72 }, ease: (u) => 1 - (1 - u) ** 3 },
  { at: 39.5, beats: 1, to: { x: HUSH_SLOT.x, y: HUSH_SLOT.y, z: 2.6 }, ease: (u) => u * u * u },
  { at: 41, beats: 3, to: { x: HUSH_SLOT.x, y: HUSH_SLOT.y, z: 2.9 }, ease: smooth },
];

function camAt(time: number): Cam {
  let from: Cam = { x: CX, y: H / 2, z: 1 };
  for (const m of MOVES) {
    const u = prog(time, bf(m.at), bf(m.at + m.beats));
    if (time < bf(m.at)) {
      break;
    }
    const k = m.ease(u);
    from = { x: lerp(from.x, m.to.x, k), y: lerp(from.y, m.to.y, k), z: Math.exp(lerp(Math.log(from.z), Math.log(m.to.z), k)) };
  }
  // A slow drift, so the frame never holds still while it searches.
  const live = prog(time, ASK, ASK + 16);
  return { x: from.x + 14 * Math.sin(time / 37) * live, y: from.y + 10 * Math.sin(time / 29) * live, z: from.z };
}

/** A field point on the screen, through the camera and the mark's parallax layer. */
function project(cam: Cam, x: number, y: number, layer: number): [number, number, number] {
  const s = cam.z * layer;
  return [(x - cam.x) * s + CX, (y - cam.y) * s + H / 2, s];
}

/** The shockwave's radius in field units, from the drop. */
function waveR(t: number): number {
  // Already out on the drop's own frame.
  return t < LIT ? 0 : 1600 * (1 - Math.exp(-(t - LIT + 1) / 12));
}

/** One gold mark: a dot and `arms` swept arcs, each company its own count, size, tilt and spin; far ones are dots. */
function drawSpiral(g: G, m: Mark, x: number, y: number, s: number, time: number, colour: string, alpha: number): void {
  const r = m.r * s;
  if (r < 7) {
    g.fillStyle = rgba(colour, alpha);
    g.fillRect(x - r * 0.5, y - r * 0.5, r, r);
    return;
  }
  const a0 = m.tilt + m.spin * time;
  g.save();
  g.translate(x, y);
  g.strokeStyle = rgba(colour, alpha);
  g.fillStyle = g.strokeStyle;
  g.lineWidth = (1.6 + 1.4 * (m.r / 32)) * Math.max(1, s * 0.8);
  g.lineCap = 'round';
  for (let k = 0; k < m.arms; k++) {
    const base = a0 + (k / m.arms) * TAU;
    g.beginPath();
    for (let i = 0; i <= 8; i++) {
      const u = i / 8;
      const rr = r * (0.35 + 0.65 * u);
      const a = base + m.curl * u;
      if (i === 0) {
        g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      } else {
        g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
    }
    g.stroke();
  }
  g.beginPath();
  g.arc(0, 0, r * 0.14, 0, TAU);
  g.fill();
  g.restore();
}

/** His brand on a mark he owns: two small horns burnt above it. */
function drawBrand(g: G, x: number, y: number, r: number, alpha: number): void {
  g.fillStyle = rgba('#fff0c2', alpha);
  for (const side of [-1, 1]) {
    g.beginPath();
    g.moveTo(x + side * r * 0.25, y - r * 0.95);
    g.quadraticCurveTo(x + side * r * 0.55, y - r * 1.25, x + side * r * 0.65, y - r * 1.7);
    g.quadraticCurveTo(x + side * r * 0.35, y - r * 1.25, x + side * r * 0.05, y - r * 1.02);
    g.closePath();
    g.fill();
  }
}

/** Where his searchlights point, in field coordinates: each flare's mark as it lands, then the slot. */
function beamTarget(t: number): [number, number] {
  if (t >= ABLAZE) {
    const k = smooth(prog(t, ABLAZE, RUSH));
    const last = FLARE_TARGETS[FLARE_TARGETS.length - 1] ?? [HUSH_SLOT.x, HUSH_SLOT.y];
    return [lerp(last[0], HUSH_SLOT.x, k), lerp(last[1], HUSH_SLOT.y, k)];
  }
  let from = FLARE_TARGETS[0] ?? [CX, 900];
  let index = -1;
  FLARE_BEATS.forEach((beat, j) => {
    if (t >= bf(beat) - 3) {
      index = j;
    }
  });
  if (index < 0) {
    return [from[0], from[1] - 300];
  }
  const to = FLARE_TARGETS[index] ?? from;
  from = FLARE_TARGETS[Math.max(0, index - 1)] ?? to;
  const k = smooth(clamp((t - (bf(FLARE_BEATS[index] ?? 36) - 3)) / 3));
  return [lerp(from[0], to[0], k), lerp(from[1], to[1], k)];
}

/** His eyes, in screen space, as the vast face behind the field holds them. */
const EYES: readonly [number, number][] = [
  [CX - 186, 936],
  [CX + 186, 936],
];

/** The searchlights: two tapered gold-white cones from his eyes to where he is looking, on from 35.5 to the silence. */
function drawBeams(g: G, t: number, cam: Cam): void {
  const on = clamp((t - bf(35.5)) / 10) * (t < HUSH ? 1 : 0);
  if (on <= 0) {
    return;
  }
  const [wx, wy] = beamTarget(t);
  // On the slot the beams judder: the search cannot take this one.
  const stutter = t >= RUSH ? 18 * Math.sin(t * 1.7) * prog(t, RUSH, HUSH) : 0;
  const [bx, by] = project(cam, wx + stutter, wy, 1);
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (const [ex, ey] of EYES) {
    const dx = bx - ex;
    const dy = by - ey;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const wide = 70 + 30 * cam.z;
    const grad = g.createLinearGradient(ex, ey, bx, by);
    grad.addColorStop(0, rgba('#fff3d6', 0.34 * on));
    grad.addColorStop(1, rgba(INK.line, 0.16 * on));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(ex + nx * 5, ey + ny * 5);
    g.lineTo(bx + nx * wide, by + ny * wide);
    g.lineTo(bx - nx * wide, by - ny * wide);
    g.lineTo(ex - nx * 5, ey - ny * 5);
    g.closePath();
    g.fill();
  }
  const pool = g.createRadialGradient(bx, by, 0, bx, by, 90 + 40 * cam.z);
  pool.addColorStop(0, rgba('#fff3d6', 0.4 * on));
  pool.addColorStop(1, rgba(INK.line, 0));
  g.fillStyle = pool;
  g.fillRect(bx - 300, by - 300, 600, 600);
  g.restore();
}

/**
 * The field and the Devil's vast face behind it, faded in by `reveal` (rising through the laugh's
 * spread, then 1). The HushBox slot is dark until the drop, then Signal Red. The red mark is drawn
 * exact but not reported as a resting logo: at its size in the field the shot's bloom haloes it
 * across the logo gate's IoU floor, so only the end card reports the mark at rest.
 */
export function drawSearchField(g: G, ctx: Ctx, time: number, reveal: number, face: { mood: number; jaw: number; look: number }): void {
  const t = Math.round(time);
  const cam = camAt(time);
  g.save();
  g.globalAlpha = 0.22 * reveal;
  drawDevil(g, time, {
    x: CX,
    y: 1060,
    scale: 620,
    draw: 1,
    mood: face.mood,
    jaw: face.jaw,
    tremble: 0.003,
    horns: 1,
    line: INK.line,
    eye: INK.key,
    // The face hides what is behind it, as the laugh's face does, so the spread lands on this exactly.
    fill: INK.bg,
    lineWidth: 5,
    look: face.look,
  });
  g.restore();
  drawBeams(g, t, cam);
  // Parallax comes in with the pull out, so the laugh's last frame and this first one match.
  const depthIn = smooth(prog(time, ASK, ASK + 16));
  const extrasIn = smooth(prog(time, ASK + 4, ASK + 20));
  const inhale = 1 - 0.72 * smooth(prog(t, HUSH, HUSH + 8));
  const wave = waveR(t);
  const hot = '#fff3d6';
  for (const [i, m] of MARKS.entries()) {
    if (m.extra && extrasIn <= 0) {
      continue;
    }
    const layer = lerp(1, m.layer, depthIn);
    let wx = m.x;
    let wy = m.y;
    let burnt = 0;
    let front = 0;
    if (wave > 0) {
      // The shockwave: marks it reaches flare white on its front, are thrown outward and burn down to embers.
      const d = Math.hypot(wx - HUSH_SLOT.x, wy - HUSH_SLOT.y) || 1;
      const past = clamp((wave - d) / 400);
      front = wave > d ? Math.exp(-(wave - d) / 120) : 0;
      wx += ((wx - HUSH_SLOT.x) / d) * 260 * past;
      wy += ((wy - HUSH_SLOT.y) / d) * 260 * past;
      burnt = past;
    }
    const [x, y, s] = project(cam, wx, wy, layer);
    const r = m.r * s;
    if (x < -r * 2 || x > W + r * 2 || y < -r * 2.5 || y > H + r * 2) {
      continue;
    }
    const branded = BRANDED[i] ?? Number.POSITIVE_INFINITY;
    const lit = t >= branded;
    const since = t - branded;
    // The flare: white-hot for a few frames as his light lands, then his gold.
    const flare = Math.max(lit && since < 10 ? Math.exp(-since / 3) : 0, front);
    const base = lit ? 1 : 0.62;
    const alpha = clamp(Math.max(base * m.depth * reveal * (m.extra ? extrasIn : 1) * inhale * (1 - 0.8 * burnt), front));
    if (lit && t < HUSH + 8 && r > 3) {
      // A mark he owns burns: a warm glow behind it, and on the whole field ablaze from 39, flame rising off every third.
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = rgba(INK.key, 0.16 * alpha * (1 + flare));
      g.beginPath();
      g.arc(x, y, r * 2.1, 0, TAU);
      g.fill();
      g.restore();
      if (t >= ABLAZE && i % 3 === 0 && r > 6) {
        drawEmber(g, time + i * 11, x + 0.2 * r * Math.sin(time / 7 + i), y - r * (0.9 + 0.5 * Math.sin(time / 5 + i * 0.7)), r * 0.45, alpha * 0.8);
      }
    }
    drawSpiral(g, m, x, y, s * (1 + 0.35 * flare), time, flare > 0.05 ? mix(INK.line, hot, flare) : INK.line, alpha);
    if (lit && r > 9) {
      drawBrand(g, x, y, r, alpha * 0.9);
    }
    if (flare > 0.05 && r > 5) {
      // The flare: a ring thrown off and a four-point star of white light as his searchlight lands.
      g.strokeStyle = rgba(hot, 0.8 * flare);
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, r * (1.2 + 1.6 * (1 - flare)), 0, TAU);
      g.stroke();
      g.lineWidth = 2.5;
      const spike = r * (1.4 + 2.6 * flare);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU + 0.4;
        g.beginPath();
        g.moveTo(x + Math.cos(a) * r * 0.5, y + Math.sin(a) * r * 0.5);
        g.lineTo(x + Math.cos(a) * spike, y + Math.sin(a) * spike);
        g.stroke();
      }
    }
    if (burnt > 0.2 && burnt < 0.98 && hash(i, 80) < 0.35) {
      drawEmber(g, time + i, x, y - 20 * burnt, 4 + 4 * hash(i, 81), 1 - burnt);
    }
  }
  const [sx, sy, ss] = project(cam, HUSH_SLOT.x, HUSH_SLOT.y, 1);
  const place = { x: sx, y: sy, size: HUSH_SLOT.size * ss };
  if (t < LIT) {
    // The slot: the mark's shape, dark, the one company that shows nothing; his light slides off it.
    if (t >= RUSH && t < HUSH) {
      const rep = prog(t, RUSH, HUSH);
      g.strokeStyle = rgba(hot, 0.25 + 0.3 * rep);
      g.lineWidth = 3;
      g.beginPath();
      g.arc(sx, sy, place.size * (0.62 + 0.05 * Math.sin(t * 1.3)), 0, TAU);
      g.stroke();
    }
    g.save();
    g.globalAlpha = reveal;
    markAtRest(g, ctx, place, mix(INK.bg, INK.line, 0.14), 'hushbox-unlit');
    g.restore();
    return;
  }
  if (wave > 0) {
    // The shockwave's front: white-hot, burning out as it spreads.
    const [, , ws] = project(cam, HUSH_SLOT.x + wave, HUSH_SLOT.y, 1);
    const front = wave * ws * 0.98;
    const fade = Math.exp(-(t - LIT) / 16);
    g.strokeStyle = rgba(hot, 0.85 * fade);
    g.lineWidth = 10 + 30 * fade;
    g.beginPath();
    g.arc(sx, sy, front, 0, TAU);
    g.stroke();
    g.strokeStyle = rgba(INK.key, 0.5 * fade);
    g.lineWidth = 60 * fade;
    g.beginPath();
    g.arc(sx, sy, front * 0.93, 0, TAU);
    g.stroke();
  }
  const red = brandPalette(ctx).key;
  // HushBox's own light while it acts: a Signal Red glow behind the mark, easing down after the drop.
  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, place.size * 1.4);
  glow.addColorStop(0, rgba(red, 0.35 * (0.5 + 0.5 * Math.exp(-(t - LIT) / 20))));
  glow.addColorStop(1, rgba(red, 0));
  g.fillStyle = glow;
  g.fillRect(sx - place.size * 1.5, sy - place.size * 1.5, place.size * 3, place.size * 3);
  markAtRest(g, ctx, place, red, 'hushbox-mark');
}

/** The face behind the field: his eyes follow his searchlights, fix on the slot, and turn to fear on the burn. */
function faceAt(time: number): { mood: number; jaw: number; look: number } {
  const t = Math.round(time);
  const [wx] = beamTarget(t);
  const fear = t >= BURN ? clamp(springOf(t, BURN, SNAPPY), 0, 1.1) : 0;
  const shock = t >= LIT ? clamp(springOf(t, LIT, SNAPPY), 0, 1.1) : 0;
  const hunt = t >= bf(35.5) && t < LIT ? clamp((wx - CX) / 500, -1, 1) : 0;
  return {
    mood: lerp(lerp(0.8, 0.1, shock), -1, fear),
    jaw: lerp(lerp(0.15 + 0.2 * prog(t, RUSH, HUSH), 0.05, shock), 0.7, fear),
    look: t < LIT ? hunt : lerp(0.2, 0.1, shock),
  };
}

/** A dark band behind the typed question, so it reads over the field. */
function questionBand(g: G, t: number): void {
  const k = 1 - prog(t, bf(38), bf(38.5));
  if (k <= 0) {
    return;
  }
  const band = g.createLinearGradient(0, 0, 0, 720);
  band.addColorStop(0, rgba(INK.bg, 0.92 * k));
  band.addColorStop(0.7, rgba(INK.bg, 0.75 * k));
  band.addColorStop(1, rgba(INK.bg, 0));
  g.fillStyle = band;
  g.fillRect(0, 0, W, 720);
}

/**
 * Beats 35-41, the search: the question types over his field; the camera pulls out to show how
 * vast it is; his eyes throw searchlights and the camera dives after them through the field
 * (36), whips to a second region (37) and a third (38), each mark his light lands on flaring
 * white and taking his brand, faster in each region; on 39 it pulls back to the whole field
 * ablaze in gold but for one dark slot; from 39.5 it rushes the slot while his light judders off
 * it; on 40.5 everything drops dark in silence.
 */
export function allOfThem(g: G, ctx: Ctx, time: number): void {
  field(g, time, INK, 1100, 0.4);
  drawSearchField(g, ctx, time, 1, faceAt(time));
  questionBand(g, Math.round(time));
}

/**
 * Beats 41-44: the drop. The slot lights Signal Red, the HushBox mark, exact, and a white-hot
 * shockwave blows his field apart and burns it; ALL BUT ONE lands; on 42.5 his claw reaches in,
 * on 43 its talons touch the mark and burn white-hot, ash falling; he recoils and his face
 * behind turns to fear.
 */
export function allButOne(g: G, ctx: Ctx, time: number): void {
  field(g, time, INK, 1100, 0.3);
  drawSearchField(g, ctx, time, 1, faceAt(time));
  const t = Math.round(time);
  const cam = camAt(time);
  const out = springOf(time, REACH, SNAPPY);
  const recoil = t >= BURN ? springOf(time, BURN + 4, SNAPPY) : 0;
  const burn = t >= BURN ? env(t, [BURN], 6) : 0;
  const hot = '#fff3d6';
  // The claw works in field coordinates, through the camera.
  g.save();
  g.translate(CX, H / 2);
  g.scale(cam.z, cam.z);
  g.translate(-cam.x, -cam.y);
  const sx = HUSH_SLOT.x + 370;
  const sy = HUSH_SLOT.y + 330;
  const rest: [number, number] = [HUSH_SLOT.x + 340, HUSH_SLOT.y + 260];
  // The wrist stops where the talons meet the mark's right edge, outside its box.
  const touch: [number, number] = [HUSH_SLOT.x + 120, HUSH_SLOT.y + 30];
  const wx = lerp(lerp(rest[0], touch[0], clamp(out, 0, 1.05)), rest[0] + 30, clamp(recoil));
  const wy = lerp(lerp(rest[1], touch[1], clamp(out, 0, 1.05)), rest[1] + 60, clamp(recoil));
  const scale = 80;
  drawClaw(g, time, {
    sx,
    sy,
    wx,
    wy,
    grip: t >= BURN ? 0.9 : 0.2,
    scale,
    line: t >= BURN ? mix(INK.line, hot, clamp(burn * 1.4)) : INK.line,
    lineWidth: (3 + 3 * clamp(burn)) / Math.max(1, cam.z * 0.6),
  });
  const [tx, ty] = tip(sx, sy, wx, wy, scale);
  if (burn > 0.02) {
    // The burn: white fire running back from the talons, ash falling.
    for (let i = 0; i < 14; i++) {
      const life = ((t - BURN) / 30 + hash(i, 71)) % 1;
      drawEmber(g, time + i * 7, tx + 10 + 30 * (hash(i, 72) - 0.3), ty - 10 + life * 160, (4 + 5 * hash(i, 73)) / cam.z * 1.6, burn * (1 - life));
    }
  }
  g.restore();
}
