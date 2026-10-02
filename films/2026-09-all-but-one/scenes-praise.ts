import {
  CX,
  FPB,
  H,
  PARCH,
  PLAYFUL,
  DEFAULT,
  SNAPPY,
  SURV,
  TAU,
  W,
  bf,
  beatPulse,
  clamp,
  env,
  hash,
  hs,
  lerp,
  rgba,
  springOf,
} from './kit.js';
import { STAMP_BEATS } from './score.js';
import { boundsOf, frameBox, imagery, padded } from './type.js';

import type { G, Palette } from './kit.js';
import type { LookContext, TextBox } from '../engine/look/index.js';

type Ctx = LookContext<'2d'>;

/** A background field with a slow radial glow and a grain that re-rolls eight times a second. */
export function field(
  g: G,
  {
    time,
    pal,
    glowY = 1300,
    glow = 0.35,
  }: { time: number; pal: Palette; glowY?: number; glow?: number }
): void {
  g.fillStyle = pal.bg;
  g.fillRect(-200, -200, W + 400, H + 400);
  const grad = g.createRadialGradient(CX, glowY, 0, CX, glowY, 1100);
  grad.addColorStop(0, rgba(pal.line, glow * 0.35));
  grad.addColorStop(1, rgba(pal.line, 0));
  g.fillStyle = grad;
  g.fillRect(-200, -200, W + 400, H + 400);
  const roll = Math.floor((time / 60) * 8);
  g.fillStyle = rgba(pal.line, 0.06);
  for (let index = 0; index < 220; index++) {
    const x = hash(index * 2 + roll * 977, 3) * W;
    const y = hash(index * 2 + 1 + roll * 977, 3) * H;
    g.fillRect(x, y, 2, 2);
  }
}

const COLS = 5;
const ROWS = 8;

/** The drawer order of the archive: a seeded shuffle, so it fills unevenly. */
function drawerRank(k: number): number {
  return hash(k, 41);
}

/** How far a drawer stands open `u` of the way through its fill: it opens and closes once. */
function drawerOpen(u: number): number {
  return u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0;
}

/**
 * An archive wall of drawers. Each drawer slides open, swallows a glowing page
 * and closes, two or three on every 16th from `fillFrom`; `noise` fills every
 * drawer with re-rolling cipher instead.
 */
export function archive(
  g: G,
  ctx: Ctx,
  { time, pal, options }: { time: number; pal: Palette; options: ArchiveOptions }
): TextBox[] {
  const boxes: TextBox[] = [];
  const x0 = CX - (COLS * DRAWER_W) / 2;
  const order = Array.from({ length: COLS * ROWS }, (_, k) => k).toSorted(
    (a, b) => drawerRank(a) - drawerRank(b)
  );
  const rankOf = new Map(order.map((k, r) => [k, r]));
  g.lineWidth = 2.5;
  for (let r = 0; r < (options.rows ?? ROWS); r++) {
    for (let c = 0; c < COLS; c++) {
      const k = r * COLS + c;
      const box = drawer(g, ctx, {
        time,
        pal,
        options,
        k,
        x: x0 + c * DRAWER_W,
        y: options.top + r * DRAWER_H,
        rank: rankOf.get(k) ?? 0,
      });
      if (box !== null) {
        boxes.push(box);
      }
    }
  }
  return boxes;
}

interface ArchiveOptions {
  fillFrom: number;
  top: number;
  noise: boolean;
  lock: string | null;
  rows?: number;
}

const DRAWER_W = 176;
const DRAWER_H = 124;

/** One drawer of the wall at (x, y): opening as its page falls in, or a drawer of cipher; returns the cipher's box. */
function drawer(
  g: G,
  ctx: Ctx,
  {
    time,
    pal,
    options,
    k,
    x,
    y,
    rank,
  }: {
    time: number;
    pal: Palette;
    options: ArchiveOptions;
    k: number;
    x: number;
    y: number;
    rank: number;
  }
): TextBox | null {
  const cw = DRAWER_W;
  const ch = DRAWER_H;
  const fillAt = options.fillFrom + 6 * Math.floor(rank / 2.5);
  const u = (time - fillAt) / 18;
  const open = options.noise ? 0.55 : drawerOpen(u);
  const filled = options.noise || Math.round(time) >= fillAt + 9;
  g.strokeStyle = pal.line;
  g.strokeRect(x + 6, y + 6, cw - 12, ch - 12);
  const dx = open * 16;
  const dy = open * 22;
  g.fillStyle = pal.bg;
  g.fillRect(x + 12 - dx, y + 12 + dy, cw - 24 + 2 * dx, ch - 24);
  g.strokeRect(x + 12 - dx, y + 12 + dy, cw - 24 + 2 * dx, ch - 24);
  g.beginPath();
  g.moveTo(x + cw / 2 - 22, y + 44 + dy);
  g.lineTo(x + cw / 2 + 22, y + 44 + dy);
  g.stroke();
  let box: TextBox | null = null;
  if (options.noise) {
    box = cipher(g, ctx, { time, pal, k, x, y, dy });
    if (options.lock !== null) {
      padlock(g, { x: x + cw - 30, y: y + 30 + dy, s: 10, color: options.lock });
    }
  } else if (filled) {
    g.fillStyle = pal.key;
    g.fillRect(x + cw / 2 - 30, y + 62 + dy, 60, 6);
    g.fillRect(x + cw / 2 - 30, y + 74 + dy, 40, 6);
  }
  if (!options.noise && u > -0.6 && u < 0.5) {
    fallingPage(g, { pal, k, x: x + cw / 2, y, dy, u });
  }
  return box;
}

/** A drawer's three lines of cipher, its drawer at `y` lowered by `dy`, reported as imagery. */
function cipher(
  g: G,
  ctx: Ctx,
  {
    time,
    pal,
    k,
    x,
    y,
    dy,
  }: { time: number; pal: Palette; k: number; x: number; y: number; dy: number }
): TextBox {
  g.fillStyle = rgba(pal.line, 0.8);
  g.font = `500 17px ${ctx.fonts['mono'] ?? 'monospace'}`;
  // Each drawer re-rolls on its own phase, so the wall never changes all at once (WCAG 2.3.1).
  const roll = Math.floor((time / 60) * 6 + hash(k, 77));
  const extents: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let li = 0; li < 3; li++) {
    let s = '';
    for (let ci = 0; ci < 12; ci++) {
      s += NOISE[Math.floor(hash(k * 97 + li * 13 + ci + roll * 7, 3) * NOISE.length)] ?? '#';
    }
    const tx = x + 20;
    const ty = y + 72 + li * 17 + dy;
    if (!ctx.hideText) {
      g.fillText(s, tx, ty);
    }
    const m = g.measureText(s);
    extents.push({
      x0: tx - m.actualBoundingBoxLeft,
      y0: ty - m.actualBoundingBoxAscent,
      x1: tx + m.actualBoundingBoxRight,
      y1: ty + m.actualBoundingBoxDescent,
    });
  }
  const lines = boundsOf(extents);
  const t = g.getTransform();
  return {
    id: `cipher-${String(k)}`,
    text: 'cipher',
    box: padded(
      frameBox(t, {
        x0: lines.x,
        y0: lines.y,
        x1: lines.x + lines.width,
        y1: lines.y + lines.height,
      })
    ),
    fontSizePx: 17 * Math.hypot(t.a, t.b),
    role: 'imagery',
  };
}

/** The page falling into its drawer: a small chat bubble with two lines of words, centred on `x`. */
function fallingPage(
  g: G,
  { pal, k, x, y, dy, u }: { pal: Palette; k: number; x: number; y: number; dy: number; u: number }
): void {
  const fu = clamp((u + 0.6) / 1.1);
  const py = lerp(y - 220, y + 40 + dy, fu * fu);
  g.save();
  g.translate(x, py);
  g.rotate(hs(k, 5) * 0.4 * (1 - fu));
  g.fillStyle = '#f4efe6';
  g.strokeStyle = pal.hot;
  g.lineWidth = 2;
  g.beginPath();
  g.roundRect(-44, -24, 88, 48, 16);
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(-30, 22);
  g.lineTo(-40, 36);
  g.lineTo(-18, 22);
  g.fill();
  g.fillStyle = '#3a3129';
  g.fillRect(-32, -10, 64 - 16 * hash(k, 9), 5);
  g.fillRect(-32, 3, 40 + 16 * hash(k, 10), 5);
  g.restore();
}

const NOISE = String.raw`▓▒░#%&@$*+=?<>/\{}[]01ABCDEF`;

/** A small padlock: HushBox's, when drawn in Signal Red. */
export function padlock(
  g: G,
  { x, y, s, color }: { x: number; y: number; s: number; color: string }
): void {
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = s * 0.35;
  g.beginPath();
  g.arc(x, y - s * 0.3, s * 0.65, Math.PI, 0);
  g.stroke();
  g.fillRect(x - s, y - s * 0.3, s * 2, s * 1.5);
  g.restore();
}

/** The sweep angle of the radar eye at `time`: one turn every two beats. */
function sweepAt(time: number): number {
  return (time / (FPB * 2)) * TAU - Math.PI / 2;
}

/** A chat bubble with scribbled words, orbiting the eye. */
function bubble(
  g: G,
  { x, y, s, pal, seed }: { x: number; y: number; s: number; pal: Palette; seed: number }
): void {
  g.save();
  g.translate(x, y);
  g.fillStyle = '#e8f6fb';
  g.strokeStyle = pal.line;
  g.lineWidth = 2.5;
  g.beginPath();
  g.roundRect(-s, -s * 0.5, s * 2, s, s * 0.35);
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(-s * 0.6, s * 0.48);
  g.lineTo(-s * 0.85, s * 0.8);
  g.lineTo(-s * 0.3, s * 0.48);
  g.fill();
  g.fillStyle = '#20313a';
  for (let index = 0; index < 2; index++) {
    g.fillRect(
      -s * 0.72,
      -s * 0.2 + index * s * 0.3,
      s * (0.9 + 0.5 * hash(seed * 7 + index, 2)),
      s * 0.1
    );
  }
  g.restore();
}

/** The thoughts orbiting the eye, each stamped FLAGGED as the sweep passes it on its beat. */
function stampedThoughts(g: G, ctx: Ctx, time: number): TextBox[] {
  const pal = SURV;
  const boxes: TextBox[] = [];
  const orbit = 0.004;
  for (const [index, beat] of STAMP_BEATS.entries()) {
    const at = bf(beat);
    const a = sweepAt(at) - orbit * at + orbit * time;
    const r = 470 + 40 * (index % 2);
    // The thoughts arrive after the words, flying in from the edge on beat 15.5.
    const arrive = clamp(springOf(time, bf(15.5) + index * 2, PLAYFUL), 0, 1.2);
    if (arrive <= 0) {
      continue;
    }
    const bx = Math.cos(a) * r * (2.2 - 1.2 * arrive);
    const by = Math.sin(a) * r * 0.6 * (2.2 - 1.2 * arrive);
    bubble(g, { x: bx, y: by, s: 62, pal, seed: index + 3 });
    if (Math.round(time) >= at) {
      const k = springOf(time, at, SNAPPY);
      g.save();
      g.translate(bx, by);
      g.rotate(hs(index, 4) * 0.25);
      g.scale(2.2 - 1.2 * k, 2.2 - 1.2 * k);
      g.strokeStyle = pal.key;
      g.lineWidth = 3;
      g.strokeRect(-78, -26, 156, 44);
      boxes.push(
        imagery(g, ctx, {
          id: `flag-${String(index)}`,
          text: 'FLAGGED',
          x: 0,
          y: 8,
          size: 30,
          face: 'mono',
          weight: 800,
          fill: pal.key,
          align: 'center',
          tracking: 0.08,
        })
      );
      g.restore();
    }
  }
  return boxes;
}

/** The radar eye: lid, iris fibres, pupil, a sweep, and thoughts orbiting that it stamps FLAGGED. */
export function eye(
  g: G,
  ctx: Ctx,
  {
    time,
    cy,
    zoom,
    stamps,
    openAt = -1e9,
  }: { time: number; cy: number; zoom: number; stamps: boolean; openAt?: number }
): TextBox[] {
  const pal = SURV;
  field(g, { time, pal, glowY: cy, glow: 0.25 });
  const boxes: TextBox[] = [];
  g.save();
  g.translate(CX, cy);
  g.scale(zoom, zoom);
  // Scan lines.
  g.fillStyle = rgba(pal.line, 0.05);
  for (let y = -1100; y < 1100; y += 6) {
    g.fillRect(-900, y, 1800, 2);
  }
  g.strokeStyle = pal.line;
  g.lineWidth = 3;
  const lidW = 470;
  // The eye opens on its shot's first beat, overshooting wide before it settles.
  const lidH = 250 * clamp(springOf(time, openAt, DEFAULT), 0.04, 1.3);
  g.beginPath();
  g.moveTo(-lidW, 0);
  g.quadraticCurveTo(0, -lidH * 1.6, lidW, 0);
  g.quadraticCurveTo(0, lidH * 1.6, -lidW, 0);
  g.stroke();
  const iris = 230;
  for (const k of [1, 0.9, 0.55, 0.4]) {
    g.beginPath();
    g.arc(0, 0, iris * k, 0, TAU);
    g.stroke();
  }
  g.lineWidth = 1.5;
  for (let index = 0; index < 90; index++) {
    const a = (index / 90) * TAU + time * 0.003;
    const r0 = iris * (0.42 + 0.05 * hash(index, 8));
    const r1 = iris * (0.86 + 0.1 * hash(index + 90, 8));
    g.strokeStyle = rgba(pal.line, 0.35 + 0.4 * hash(index + 200, 8));
    g.beginPath();
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a + 0.04) * r1, Math.sin(a + 0.04) * r1);
    g.stroke();
  }
  const pupil = iris * (0.3 + 0.08 * beatPulse(time));
  g.fillStyle = '#000000';
  g.beginPath();
  g.arc(0, 0, pupil, 0, TAU);
  g.fill();
  // The sweep.
  const s = sweepAt(time);
  const wedge = g.createConicGradient(s - 0.9, 0, 0);
  wedge.addColorStop(0, rgba(pal.line, 0));
  wedge.addColorStop(0.143, rgba(pal.line, 0.45));
  wedge.addColorStop(0.1432, rgba(pal.line, 0));
  wedge.addColorStop(1, rgba(pal.line, 0));
  g.fillStyle = wedge;
  g.beginPath();
  g.arc(0, 0, 620, 0, TAU);
  g.fill();
  g.strokeStyle = pal.hot;
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(Math.cos(s) * 620, Math.sin(s) * 620);
  g.stroke();
  if (stamps) {
    boxes.push(...stampedThoughts(g, ctx, time));
  }
  g.restore();
  return boxes;
}

/** Beats 15-18: the eye opens and stamps the messages orbiting it, pushed on each stamp. */
export function watch(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  const hits = STAMP_BEATS.map((beat) => bf(beat));
  const zoom = 1 + 0.03 * env(Math.round(time), hits, 4) + (time - start) * 0.0008;
  // The eye sits high this time, the words under it.
  return eye(g, ctx, { time, cy: 700, zoom, stamps: true, openAt: start });
}

/** Beats 12-15: the archive in parchment; messages drop into the drawers on the 16ths as the camera tilts down. */
export function save(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  field(g, { time, pal: PARCH, glowY: 900, glow: 0.1 });
  const lt = time - start;
  // The wall fills the top of the frame and the words sit under it, low in the safe box.
  return archive(g, ctx, {
    time,
    pal: PARCH,
    options: {
      fillFrom: start + 6,
      top: 60 - lt * 1.2,
      noise: false,
      lock: null,
    },
  });
}
