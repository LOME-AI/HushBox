import { CX, INK, TAU, bf, hash, hs, mix, prog, rgba, smooth } from './kit.js';
import { brandPalette, ground } from './scenes-hush.js';
import { padlock } from './scenes-praise.js';
import { fontOf } from './type.js';

import type { G, Palette } from './kit.js';
import type { LookContext, TextBox } from '../engine/look/index.js';

type Ctx = LookContext<'2d'>;

/** The SOLD stamp's handle, plate and face, drawn at its own origin (the face's top centre). */
function drawStampBody(g: G, font: string): void {
  g.fillStyle = '#3a2a12';
  g.fillRect(-40, -210, 80, 150);
  g.beginPath();
  g.ellipse(0, -220, 70, 34, 0, 0, TAU);
  g.fill();
  g.fillStyle = INK.line;
  g.fillRect(-190, -70, 380, 70);
  g.strokeStyle = INK.line;
  g.lineWidth = 6;
  g.strokeRect(-170, 0, 340, 110);
  g.font = font;
  g.fillStyle = INK.line;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillText('SOLD', 0, 88);
}

type Pt = readonly [number, number];

/** The cracks that split the stamp into its three pieces, in the stamp's own space. */
const STAMP_CRACKS: readonly (readonly Pt[])[] = [
  [
    [-60, -260],
    [-40, -120],
    [-80, -40],
    [-30, 40],
    [-70, 130],
  ],
  [
    [-40, -120],
    [30, -60],
    [70, 20],
    [40, 80],
    [95, 130],
  ],
];

/** The three pieces the cracks cut, each with the direction it parts and tumbles in. */
const STAMP_PIECES: readonly { poly: readonly Pt[]; dx: number; dy: number; turn: number }[] = [
  {
    poly: [
      [-260, -300],
      [-60, -300],
      [-60, -260],
      [-40, -120],
      [-80, -40],
      [-30, 40],
      [-70, 130],
      [-260, 130],
    ],
    dx: -1,
    dy: -0.3,
    turn: -1,
  },
  {
    poly: [
      [-60, -300],
      [260, -300],
      [260, 130],
      [95, 130],
      [40, 80],
      [70, 20],
      [30, -60],
      [-40, -120],
      [-60, -260],
    ],
    dx: 1,
    dy: -0.5,
    turn: 1.3,
  },
  {
    poly: [
      [-40, -120],
      [30, -60],
      [70, 20],
      [40, 80],
      [95, 130],
      [-70, 130],
      [-30, 40],
      [-80, -40],
    ],
    dx: 0.1,
    dy: 1,
    turn: 0.6,
  },
];

/** Beats 56-60: the claim lands; the SOLD stamp slams at a page in a red frame, bounces, slams and cracks, holds, and flies apart. */
export function notForSale(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  const pal = brandPalette(ctx);
  ground(g, time, pal, 1100);
  const push = 1 + 0.08 * smooth(prog(time, bf(57), start + 96));
  g.save();
  g.translate(CX, 680);
  g.scale(push, push);
  g.translate(-CX, -680);
  const px = CX;
  // The page sits high; the claim lands under it.
  const py = 680;
  stampPage(g, pal, { px, py });
  // The claim lands alone on 56. The stamp drops in and slams on 56.5, is hurled back up, and on
  // 57.25 slams again and cracks: it holds cracked on the page for half a beat, then flies apart on 57.75.
  // The stamp is keyed to the frame, so its fast drop draws once under motion blur, not as a ghost.
  const tt = Math.round(time);
  const stamp = { font: fontOf(ctx, 'serif', 900, 92), sx: px, sy: py - 330 };
  if (tt < STAMP_SHATTER) {
    stampHeld(g, stamp, { tt, start });
  } else {
    stampShattered(g, stamp, tt);
  }
  g.restore();
  return [];
}

const STAMP_SLAMS = [bf(56.5), bf(57.25)];
const STAMP_CRACK = bf(57.25);
const STAMP_SHATTER = bf(57.75);

/** The stamp's face font and where it hangs over the page. */
interface Stamp {
  font: string;
  sx: number;
  sy: number;
}

/** The page in its red frame, its lines of words, and the padlock on its corner. */
function stampPage(g: G, pal: Palette, { px, py }: { px: number; py: number }): void {
  g.save();
  g.translate(px, py);
  g.rotate(-0.04);
  g.fillStyle = mix(pal.bg, '#ffffff', 0.9);
  g.fillRect(-220, -280, 440, 560);
  g.strokeStyle = pal.key;
  g.lineWidth = 10;
  g.strokeRect(-240, -300, 480, 600);
  g.fillStyle = rgba(pal.bg, 0.55);
  for (let index = 0; index < 12; index++) {
    g.fillRect(-170, -220 + index * 38, 340 - (index % 4) * 50, 12);
  }
  g.restore();
  padlock(g, { x: px + 190, y: py - 250, s: 22, color: pal.key });
}

/** How high the stamp hangs over the page: dropping in, then hurled back up between its slams. */
function stampHeight(tt: number, start: number): number {
  const last = STAMP_SLAMS.findLast((s) => s <= tt);
  const next = STAMP_SLAMS.find((s) => s > tt);
  if (last === undefined) {
    return 760 * (1 - prog(tt, start + 2, STAMP_SLAMS[0] ?? 0) ** 2);
  }
  if (next === undefined) {
    return 0;
  }
  const u = prog(tt, last, next);
  return 260 * 4 * u * (1 - u);
}

/** Traces an outline as the canvas's current path. */
function trace(g: G, pts: readonly Pt[]): void {
  g.beginPath();
  for (const [index, [x, y]] of pts.entries()) {
    if (index === 0) {
      g.moveTo(x, y);
    } else {
      g.lineTo(x, y);
    }
  }
}

/** The stamp before it flies apart: dropping, slamming, bouncing, then held cracked in three pieces. */
function stampHeld(
  g: G,
  { font, sx, sy }: Stamp,
  { tt, start }: { tt: number; start: number }
): void {
  const hgt = stampHeight(tt, start);
  const last = STAMP_SLAMS.findLast((s) => s <= tt);
  // Squash on each landing, flat and wide, then a stretch as it springs back.
  const since = last === undefined ? 99 : tt - last;
  const squash = 1 - 0.32 * Math.exp(-since / 4) * Math.cos(since / 2.2);
  const cracked = tt >= STAMP_CRACK;
  // The cracked key pose: three pieces, parted a few pixels along the cracks and held.
  const part = cracked ? 6 + 4 * prog(tt, STAMP_CRACK, STAMP_SHATTER) : 0;
  const pieces = cracked ? STAMP_PIECES : [null];
  g.save();
  g.translate(sx, sy - hgt);
  g.scale(1 / squash, squash);
  g.rotate(cracked ? 0.03 : 0.08 * Math.sin(tt * 0.1));
  for (const piece of pieces) {
    g.save();
    if (piece !== null) {
      g.translate(piece.dx * part, piece.dy * part);
      g.rotate(piece.turn * part * 0.004);
      trace(g, piece.poly);
      g.closePath();
      g.clip();
    }
    drawStampBody(g, font);
    g.restore();
  }
  if (cracked) {
    g.strokeStyle = '#1a1206';
    g.lineWidth = 7;
    g.lineJoin = 'miter';
    for (const crack of STAMP_CRACKS) {
      trace(g, crack);
      g.stroke();
    }
  }
  g.restore();
}

/** The stamp flying apart: its three big pieces tumbling, then the dust of shards following them out. */
function stampShattered(g: G, { font, sx, sy }: Stamp, tt: number): void {
  // Two frames in on the shatter frame itself, so the pieces are already apart and the stamp never reads whole again.
  const u = (tt - STAMP_SHATTER + 2) / 60;
  for (const piece of STAMP_PIECES) {
    g.save();
    g.translate(sx + piece.dx * 1400 * u, sy + piece.dy * 900 * u + 1600 * u * u);
    g.rotate(piece.turn * 6 * u);
    trace(g, piece.poly);
    g.closePath();
    g.clip();
    drawStampBody(g, font);
    g.restore();
  }
  for (let index = 0; index < 36; index++) {
    const a = hash(index, 31) * TAU;
    const v = 700 + 900 * hash(index, 32);
    const x = sx + Math.cos(a) * v * u;
    const y = sy + Math.sin(a) * v * u * 0.7 + 1400 * u * u;
    g.save();
    g.translate(x, y);
    g.rotate(hs(index, 33) * 10 * u);
    g.fillStyle = index % 3 === 0 ? '#3a2a12' : INK.line;
    g.beginPath();
    g.moveTo(-20 - 20 * hash(index, 34), -10);
    g.lineTo(25, -18 * hash(index, 35));
    g.lineTo(10 * hash(index, 36), 22);
    g.closePath();
    g.fill();
    g.restore();
  }
}
