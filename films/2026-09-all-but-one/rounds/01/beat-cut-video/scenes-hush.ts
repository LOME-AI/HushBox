import { drawDevil } from './devil.js';
import { drawEmber } from './fire.js';
import {
  CX,
  DEFAULT,
  FPB,
  H,
  HEAVY,
  INK,
  PLAYFUL,
  SNAPPY,
  TAU,
  W,
  bf,
  beatPulse,
  clamp,
  env,
  hash,
  hs,
  lerp,
  mix,
  outCubic,
  prog,
  rgba,
  smooth,
  springOf,
} from './kit.js';
import { archive, padlock } from './scenes-praise.js';
import { imagery } from './type.js';

import type { G, Palette } from './kit.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

/** HushBox's world: the brand's charcoal and Signal Red, with the Devil's gold now a guest in it. */
export function brandPalette(ctx: Ctx): Palette {
  return { bg: hex(ctx.brand.background), line: '#8d8479', hot: hex(ctx.brand.foreground), key: hex(ctx.brand.brandRed), dim: '#2a2622' };
}

/** Daylight: HushBox's values shown on warm paper, Signal Red kept, the Devil drawn in dark ink. */
export function lightPalette(ctx: Ctx): Palette {
  return { bg: '#efe8dc', line: '#4a4038', hot: '#1c1714', key: hex(ctx.brand.brandRed), dim: '#d8cfc0' };
}

/** The Devil's gold, darkened to read on daylight paper. */
const DARK_GOLD = '#7a520e';

/** A brand colour as `#rrggbb`, whatever CSS colour syntax the stylesheet used. */
function hex(css: string): string {
  const cached = HEX.get(css);
  if (cached !== undefined) {
    return cached;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (g === null) {
    throw new Error('beat-cut-video: no 2D context to resolve a brand colour');
  }
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gg = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
  const out = `#${((r << 16) | (gg << 8) | b).toString(16).padStart(6, '0')}`;
  HEX.set(css, out);
  return out;
}
const HEX = new Map<string, string>();

function ground(g: G, time: number, pal: Palette, glowY: number): void {
  g.fillStyle = pal.bg;
  g.fillRect(-200, -200, W + 400, H + 400);
  const grad = g.createRadialGradient(CX, glowY, 0, CX, glowY, 1000);
  grad.addColorStop(0, rgba(pal.key, 0.1));
  grad.addColorStop(1, rgba(pal.key, 0));
  g.fillStyle = grad;
  g.fillRect(-200, -200, W + 400, H + 400);
  const roll = Math.floor((time / 60) * 8);
  g.fillStyle = rgba(pal.hot, 0.035);
  for (let i = 0; i < 200; i++) {
    g.fillRect(hash(i * 2 + roll * 977, 5) * W, hash(i * 2 + 1 + roll * 977, 5) * H, 2, 2);
  }
}

/** A token of an AI company: a ring around a small abstract glyph, none of them a real mark. */
function token(g: G, x: number, y: number, r: number, kind: number, stroke: string, fill: string | null): void {
  g.save();
  g.translate(x, y);
  g.lineWidth = Math.max(1.5, r * 0.09);
  g.strokeStyle = stroke;
  if (fill !== null) {
    g.fillStyle = fill;
    g.beginPath();
    g.arc(0, 0, r, 0, TAU);
    g.fill();
  }
  g.beginPath();
  g.arc(0, 0, r, 0, TAU);
  g.stroke();
  const s = r * 0.5;
  g.beginPath();
  switch (kind % 5) {
    case 0:
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        g.lineTo(Math.cos(a) * s, Math.sin(a) * s);
      }
      g.closePath();
      break;
    case 1:
      g.moveTo(-s, s * 0.6);
      g.lineTo(0, -s);
      g.lineTo(s, s * 0.6);
      g.closePath();
      break;
    case 2:
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI;
        g.moveTo(Math.cos(a) * s, Math.sin(a) * s);
        g.lineTo(-Math.cos(a) * s, -Math.sin(a) * s);
      }
      break;
    case 3:
      g.moveTo(-s, 0);
      g.bezierCurveTo(-s * 0.4, -s, s * 0.4, s, s, 0);
      break;
    default:
      g.rect(-s * 0.6, -s * 0.6, s * 1.2, s * 1.2);
  }
  g.stroke();
  g.restore();
}

const TOKEN_COLS = 7;
const TOKEN_ROWS = 10;
/** The one token that turns red: HushBox. */
const ONE_INDEX = 4 * TOKEN_COLS + 3;

function tokenAt(i: number): [number, number] {
  const c = i % TOKEN_COLS;
  const r = Math.floor(i / TOKEN_COLS);
  return [CX + (c - (TOKEN_COLS - 1) / 2) * 134 + (r % 2) * 22, 720 + r * 118];
}

/** Beat 40-44: every AI company a gold token; in the silence they dim; on 42 one turns red. */
export function one(g: G, ctx: Ctx, time: number): void {
  const red = hex(ctx.brand.brandRed);
  g.fillStyle = '#030202';
  g.fillRect(-200, -200, W + 400, H + 400);
  const beats = [bf(40), bf(41)];
  const heart = env(time, beats, 5);
  const turn = springOf(time, bf(42), PLAYFUL);
  const dimmed = prog(time, bf(40), bf(42));
  const [ox, oy] = tokenAt(ONE_INDEX);
  const zoom = 1 + 0.5 * smooth(prog(time, bf(42), bf(44)));
  g.save();
  g.translate(ox, oy);
  g.scale(zoom, zoom);
  g.translate(-ox, -oy);
  for (let i = 0; i < TOKEN_COLS * TOKEN_ROWS; i++) {
    if (i === ONE_INDEX) {
      continue;
    }
    const [x, y] = tokenAt(i);
    const away = turn > 0 ? outCubic(prog(time, bf(42), bf(44))) : 0;
    const dx = (x - ox) * away * 0.25;
    const dy = (y - oy) * away * 0.25;
    const alpha = lerp(0.95, 0.4, dimmed) * (1 - 0.7 * away) * (0.8 + 0.2 * hash(i + Math.floor(time / 6), 2));
    token(g, x + dx, y + dy, 40 * (1 + 0.12 * heart), i * 7 + 3, rgba(INK.line, alpha), null);
  }
  const s = 40 * (1 + 0.12 * heart + 0.9 * turn);
  const c = time >= bf(42) ? red : INK.line;
  // The hit squashes the token flat and wide, then it springs tall, wobbles and settles.
  const since = (time - bf(42)) / 60;
  const wobble = since >= 0 ? Math.exp(-6 * since) * Math.cos(2 * Math.PI * 3.4 * since) : 0;
  g.save();
  g.translate(ox, oy);
  g.rotate(0.25 * wobble * Math.sin(since * 9));
  g.scale(1 + 0.45 * wobble, 1 - 0.4 * wobble);
  token(g, 0, 0, s, 0, c, time >= bf(42) ? rgba(red, 0.25) : null);
  g.restore();
  if (time >= bf(42)) {
    g.strokeStyle = rgba(red, clamp(1 - (time - bf(42)) / 40));
    g.lineWidth = 4;
    g.beginPath();
    g.arc(ox, oy, s + (time - bf(42)) * 9, 0, TAU);
    g.stroke();
  }
  g.restore();
}

const NOISE = '▓▒░#%&@$*+=?<>/{}[]01ABCDEF';

/** A string scrambled from `at` frames, one character every `each` frames, re-rolling twelve times a second. */
function scrambled(text: string, time: number, at: number, each: number, seed: number): string {
  const roll = Math.floor((time / 60) * 6);
  return [...text]
    .map((ch, i) =>
      ch === ' ' || time < at + i * each ? ch : (NOISE[Math.floor(hash(i * 13 + roll * 7 + seed, 9) * NOISE.length)] ?? '#')
    )
    .join('');
}

/** The Devil at the bottom of the frame, rising into view afraid. */
function fearful(g: G, time: number, pal: Palette, y: number, scale: number, fear: number, jaw: number, line = INK.line): void {
  drawDevil(g, time, {
    x: CX,
    y,
    scale,
    draw: 1,
    mood: -fear,
    jaw,
    tremble: 0.006 + 0.012 * fear,
    horns: 1,
    line,
    eye: INK.key,
    fill: pal.bg,
    lineWidth: 4,
  });
}

/** Sweat: drops sliding down the Devil's brow and falling. */
function sweat(g: G, time: number, x: number, y: number, scale: number): void {
  for (let i = 0; i < 5; i++) {
    const life = ((time / 60) * (0.7 + 0.3 * hash(i, 44)) + hash(i, 45)) % 1;
    const sx = x + hs(i, 46) * scale * 0.6;
    const sy = y - scale * 0.5 + life * scale * 1.2;
    g.fillStyle = rgba('#4a90c8', 0.85 * (1 - life));
    g.beginPath();
    g.moveTo(sx, sy - 14);
    g.quadraticCurveTo(sx + 9, sy + 4, sx, sy + 8);
    g.quadraticCurveTo(sx - 9, sy + 4, sx, sy - 14);
    g.fill();
  }
}

/** Beats 44-48, one read: with the words the red ring closes, the message scrambles to cipher and a padlock snaps shut. */
export function encrypted(g: G, ctx: Ctx, time: number, start: number, frame: number): TextBox[] {
  const pal = brandPalette(ctx);
  ground(g, time, pal, 900);
  const close = springOf(time, start, HEAVY);
  const ringR = lerp(1100, 370, close);
  const bx = CX;
  const by = 1060;
  const boxes: TextBox[] = [];
  g.fillStyle = mix(pal.bg, '#ffffff', 0.08);
  g.strokeStyle = pal.hot;
  g.lineWidth = 3;
  g.beginPath();
  g.roundRect(bx - 330, by - 70, 660, 140, 36);
  g.fill();
  g.stroke();
  const secret = 'my test results came back';
  boxes.push(
    imagery(g, ctx, { id: 'enc-secret', text: scrambled(secret, frame, bf(44) + 10, 1, 3), x: bx - 290, y: by + 14, size: 40, face: 'mono', weight: 600, fill: pal.hot })
  );
  // The ring's glyphs hold still until the message scrambles, then re-roll with it.
  const roll = frame < bf(44) + 10 ? 0 : Math.floor(frame / 5);
  g.save();
  g.translate(bx, by);
  g.rotate(start * 0.01 + (time - start) * 0.006);
  g.strokeStyle = pal.key;
  g.lineWidth = 8;
  g.beginPath();
  g.arc(0, 0, ringR, 0, TAU);
  g.stroke();
  const glyphs = 48;
  for (let i = 0; i < glyphs; i++) {
    g.save();
    g.rotate((i / glyphs) * TAU);
    g.translate(0, -ringR - 26);
    boxes.push(
      imagery(g, ctx, { id: `ring-${String(i)}`, text: NOISE[Math.floor(hash(i + roll * 3, 17) * NOISE.length)] ?? '#', x: 0, y: 0, size: 26, face: 'mono', weight: 700, fill: rgba(pal.key, 0.8), align: 'center' })
    );
    g.restore();
  }
  g.restore();
  if (time >= bf(45)) {
    const k = springOf(time, bf(45), SNAPPY);
    padlock(g, bx + 300, by - 70, 26 * k, pal.key);
  }
  return boxes;
}

/** Beats 51-56, one read: the words over a wall of cipher; on the hit a red lock snaps onto every drawer in a wave, and the camera tracks along the wall. */
export function unreadable(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  const pal = lightPalette(ctx);
  ground(g, time, pal, 1300);
  const track = -120 + 240 * smooth(prog(time, start, start + 120));
  g.save();
  g.translate(track, 0);
  const boxes = archive(g, ctx, time, pal, { fillFrom: 0, top: 780, noise: true, lock: null, rows: 8 });
  // The locks: each drawer's snaps on a frame later than the one to its left, a wave across the wall.
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 5; c++) {
      const at = start + c * 3 + r;
      if (time < at) {
        continue;
      }
      const k = springOf(time, at, SNAPPY);
      padlock(g, CX - 440 + c * 176 + 146, 780 + r * 124 + 30, 12 * k, pal.key);
    }
  }
  g.restore();
  return boxes;
}

/** The Devil's gold lens: a ring and handle, the cipher it magnifies inside. */
function lensAt(g: G, ctx: Ctx, time: number, pal: Palette, lx: number, ly: number, r: number): void {
  g.save();
  g.beginPath();
  g.arc(lx, ly, r, 0, TAU);
  g.clip();
  g.fillStyle = mix(pal.bg, '#c9a14a', 0.4);
  g.fillRect(lx - r, ly - r, 2 * r, 2 * r);
  g.font = `700 46px ${ctx.fonts['mono'] ?? 'monospace'}`;
  g.fillStyle = rgba(DARK_GOLD, 0.9);
  for (let row = 0; row < 8; row++) {
    let line = '';
    for (let c = 0; c < 10; c++) {
      line += NOISE[Math.floor(hash(row * 31 + c + Math.floor((time / 60) * 6 + row / 7) * 5, 21) * NOISE.length)] ?? '#';
    }
    if (!ctx.hideText) {
      g.fillText(line, lx - r, ly - r + 44 + row * 52);
    }
  }
  g.restore();
  g.save();
  g.strokeStyle = DARK_GOLD;
  g.lineWidth = 14;
  g.beginPath();
  g.arc(lx, ly, r, 0, TAU);
  g.stroke();
  g.lineCap = 'round';
  g.lineWidth = 28;
  g.beginPath();
  g.moveTo(lx + r * 0.72, ly + r * 0.72);
  g.lineTo(lx + r * 1.55, ly + r * 1.55);
  g.stroke();
  g.restore();
}

/** Beats 56-59, one read: the Devil swings his lens up, it holds only noise, NO KEY springs up, and he recoils. */
export function lens(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  const pal = lightPalette(ctx);
  ground(g, time, pal, 1200);
  const recoil = springOf(time, bf(57), DEFAULT);
  fearful(g, time, pal, 1320 + 40 * recoil, 360 * (1 - 0.06 * recoil), 0.55 + 0.3 * clamp(recoil), 0.2 + 0.4 * clamp(recoil), DARK_GOLD);
  const up = clamp(springOf(time, start - 4, DEFAULT), 0, 1.15);
  const lx = lerp(1200, 560, up) + 30 * Math.sin((time - start) / 25);
  const ly = lerp(1700, 1120, up);
  lensAt(g, ctx, time, pal, lx, ly, 210);
  const boxes: TextBox[] = [];
  if (time >= bf(57)) {
    const k = springOf(time, bf(57), SNAPPY);
    g.save();
    g.translate(lx, ly + 300);
    g.scale(k, k);
    g.fillStyle = mix(pal.bg, '#ffffff', 0.7);
    g.fillRect(-150, -52, 300, 76);
    g.strokeStyle = DARK_GOLD;
    g.lineWidth = 4;
    g.strokeRect(-150, -52, 300, 76);
    boxes.push(
      imagery(g, ctx, { id: 'lens-readout', text: 'NO KEY', x: 0, y: 0, size: 48, face: 'mono', weight: 800, fill: DARK_GOLD, align: 'center', tracking: 0.2 })
    );
    g.restore();
  }
  return boxes;
}

/** Beats 48-51, one read: extreme close on the Devil's eyes; on the hit they snap wide, his head jerks back, the red ring shines in his pupils. */
export function flinch(g: G, ctx: Ctx, time: number, start: number): void {
  const pal = brandPalette(ctx);
  ground(g, time, pal, 900);
  const jerk = springOf(time, start, SNAPPY);
  const scale = 950 * (1 - 0.1 * clamp(jerk, 0, 1.2)) + (time - start) * 0.8;
  const y = 1140 + 50 * clamp(jerk, 0, 1.2);
  drawDevil(g, time, {
    x: CX + 20,
    y,
    scale,
    draw: 1,
    mood: lerp(-0.4, -0.85, clamp(jerk)),
    jaw: 0.3,
    tremble: 0.004,
    horns: 1,
    line: INK.line,
    eye: INK.key,
    fill: pal.bg,
    lineWidth: 7,
    look: 0.15 * Math.sin((time - start) / 9),
    tilt: -0.05 * clamp(jerk),
  });
  // HushBox's ring, reflected in both pupils, the left larger as his left eye is.
  for (const [side, size] of [[-1, 1.1], [1, 0.85]] as const) {
    const ex = CX + 20 + side * 0.3 * scale;
    const ey = y - 0.2 * scale;
    g.strokeStyle = rgba(pal.key, 0.9);
    g.lineWidth = 5;
    g.beginPath();
    g.arc(ex, ey, 22 * size * clamp(jerk, 0, 1.2), 0, TAU);
    g.stroke();
  }
}

/** Beats 63-66, one read: the Devil sweats as the stamp's shards rain past him; on 65 he looks up. */
export function sweatShot(g: G, ctx: Ctx, time: number, start: number): void {
  const pal = brandPalette(ctx);
  ground(g, time, pal, 1300);
  const pull = 1 - 0.08 * prog(time, start, start + 72);
  g.save();
  g.translate(CX, 1200);
  g.scale(pull, pull);
  g.translate(-CX, -1200);
  const u = (time - start) / 60 + 0.4;
  for (let i = 0; i < 40; i++) {
    const x = hash(i, 131) * W;
    const y = -200 + ((u * (500 + 500 * hash(i, 132)) + hash(i, 133) * H) % (H + 400));
    // A few shards fall close to the lens, large and fast, in front of him.
    const near = i < 6 ? 3.2 : 1;
    g.save();
    g.translate(x, i < 6 ? (y * 1.4) % (H + 400) - 200 : y);
    g.scale(near, near);
    g.rotate(hs(i, 134) * 6 * u);
    g.fillStyle = i % 3 === 0 ? '#3a2a12' : INK.line;
    g.beginPath();
    g.moveTo(-18 - 18 * hash(i, 135), -9);
    g.lineTo(22, -16 * hash(i, 136));
    g.lineTo(9 * hash(i, 137), 20);
    g.closePath();
    g.fill();
    g.restore();
  }
  const up = springOf(time, bf(65), DEFAULT);
  // Small and low in the frame, off to one side under the falling shards; on 65 he looks up.
  const dy = 1560 - 60 * clamp(up);
  const dx = 360;
  drawDevil(g, time, {
    x: dx,
    y: dy,
    scale: 230,
    draw: 1,
    mood: -0.9,
    jaw: 0.25 + 0.1 * Math.sin(time * 1.3),
    tremble: 0.014,
    horns: 1,
    line: INK.line,
    eye: INK.key,
    fill: pal.bg,
    lineWidth: 5,
    look: lerp(-0.5, 0.2, clamp(up)),
    tilt: lerp(0.18, -0.22, clamp(up)),
  });
  sweat(g, time, dx, dy, 230);
  g.restore();
}

/** Beat 52-56: the SOLD stamp slams at a page in a red frame, bounces, slams, and shatters. */
export function notForSale(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  const pal = brandPalette(ctx);
  ground(g, time, pal, 1100);
  const push = 1 + 0.08 * smooth(prog(time, bf(60), start + 96));
  g.save();
  g.translate(CX, 1330);
  g.scale(push, push);
  g.translate(-CX, -1330);
  const boxes: TextBox[] = [];
  const px = CX;
  const py = 1330;
  g.save();
  g.translate(px, py);
  g.rotate(-0.04);
  g.fillStyle = mix(pal.bg, '#ffffff', 0.9);
  g.fillRect(-220, -280, 440, 560);
  g.strokeStyle = pal.key;
  g.lineWidth = 10;
  g.strokeRect(-240, -300, 480, 600);
  g.fillStyle = rgba(pal.bg, 0.55);
  for (let i = 0; i < 12; i++) {
    g.fillRect(-170, -220 + i * 38, 340 - (i % 4) * 50, 12);
  }
  g.restore();
  padlock(g, px + 190, py - 250, 22, pal.key);
  const slams = [bf(59), bf(60)];
  const shatterAt = slams[1] ?? 0;
  if (time < shatterAt) {
    // Between slams the stamp is hurled back up by the page: height is a bounce keyed to the last slam.
    const last = slams.filter((s) => s <= time).pop();
    const next = slams.find((s) => s > time) ?? shatterAt;
    let hgt: number;
    if (last === undefined) {
      hgt = 420 * (1 - prog(time, start - 10, slams[0] ?? 0) ** 2);
    } else {
      const u = prog(time, last, next);
      hgt = 260 * 4 * u * (1 - u);
    }
    const squash = 1 - 0.25 * env(time, slams, 3);
    g.save();
    g.translate(px, py - 330 - hgt);
    g.scale(1 / squash, squash);
    g.rotate(0.08 * Math.sin(time * 0.1));
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
    boxes.push(
      imagery(g, ctx, { id: 'stamp', text: 'SOLD', x: 0, y: 88, size: 92, face: 'serif', weight: 900, fill: INK.line, align: 'center' })
    );
    g.restore();
  } else {
    const u = (time - shatterAt) / 60;
    for (let i = 0; i < 36; i++) {
      const a = hash(i, 31) * TAU;
      const v = 700 + 900 * hash(i, 32);
      const x = px + Math.cos(a) * v * u;
      const y = py - 330 + Math.sin(a) * v * u * 0.7 + 1400 * u * u;
      g.save();
      g.translate(x, y);
      g.rotate(hs(i, 33) * 10 * u);
      g.fillStyle = i % 3 === 0 ? '#3a2a12' : INK.line;
      g.beginPath();
      g.moveTo(-20 - 20 * hash(i, 34), -10);
      g.lineTo(25, -18 * hash(i, 35));
      g.lineTo(10 * hash(i, 36), 22);
      g.closePath();
      g.fill();
      g.restore();
    }
  }
  g.restore();
  return boxes;
}

/** Radians a frame the vortex turns: slow enough that its red never flickers (WCAG 2.3.1 red flashes). */
const VORTEX_RATE = 0.03;
/** The vortex's angle when the scream shot hands it to the mark. */
const VORTEX_END = 72 * VORTEX_RATE;

/** Beats 66-69: the Devil screams, and his strokes tear loose into a red spiral. */
export function notHushbox(g: G, ctx: Ctx, time: number, start: number): void {
  const pal = brandPalette(ctx);
  ground(g, time, pal, 1150);
  const shatter = smooth(prog(time, start + 30, start + 72));
  const spin = (time - start) * VORTEX_RATE;
  const vr = 80 + 300 * shatter;
  g.save();
  g.translate(CX, 1150);
  g.rotate(spin);
  g.strokeStyle = rgba(pal.key, 0.2 + 0.45 * shatter);
  g.lineCap = 'round';
  for (let k = 0; k < 6; k++) {
    g.lineWidth = 5 + 11 * shatter;
    g.beginPath();
    for (let i = 0; i <= 30; i++) {
      const s = i / 30;
      const a = (k / 6) * TAU - 3.2 * s;
      const rr = vr * (0.2 + 1.3 * s);
      g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.stroke();
  }
  g.restore();
  drawDevil(g, time, {
    x: CX,
    y: 1200,
    // The scream's anticipation: the head pulls back with the mouth shut, then it opens full.
    scale: (340 + (time - start) * 0.8) * (time < start + 6 ? 0.95 : 1),
    draw: 1,
    mood: -1,
    jaw: time < start + 6 ? 0.1 : clamp(springOf(time, start + 6, SNAPPY), 0, 1.1) * (0.85 + 0.15 * Math.sin(time * 0.6)),
    look: -0.4,
    tilt: time < start + 6 ? 0.06 : -0.04,
    tremble: 0.025,
    horns: 1,
    line: INK.line,
    eye: INK.key,
    fill: shatter > 0.1 ? null : pal.bg,
    lineWidth: 4.5,
    shatter,
    pullX: CX,
    pullY: 1150,
  });
}

/** A pinwheel of six arms around a dot: HushBox's mark, `curl` bends the arms, `open` sets how far they reach. */
export function mark(g: G, x: number, y: number, r: number, color: string, spin: number, curl: number, open: number, dot = 1): void {
  g.save();
  g.translate(x, y);
  g.rotate(spin);
  g.fillStyle = color;
  g.strokeStyle = color;
  g.beginPath();
  g.arc(0, 0, r * 0.165 * dot, 0, TAU);
  g.fill();
  g.lineCap = 'round';
  g.lineWidth = r * 0.12;
  for (let k = 0; k < 6; k++) {
    const base = (k / 6) * TAU - Math.PI / 2 + 0.2;
    g.beginPath();
    for (let i = 0; i <= 20; i++) {
      const s = i / 20;
      const rr = r * (0.48 + 0.49 * s * open);
      const a = base - curl * s;
      if (i === 0) {
        g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      } else {
        g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
    }
    g.stroke();
  }
  g.restore();
}

/** The end card's two shots, each its own composition, joined by a hard cut. */
export type EndShot = 'mark' | 'tagline';

/** Where the mark sits in each end shot: large and centred as it lands, then small in the lockup. */
export function markPlace(shot: EndShot): { x: number; y: number; r: number } {
  return shot === 'mark' ? { x: CX, y: 760, r: 260 } : { x: 232, y: 440, r: 92 };
}

/** The beat the Devil's last ember reaches the mark's dot, and the mark turns one arm on. */
export const LAST_EMBER_BEAT = 74;

/**
 * Beats 69-75. The mark shot: the mark lands with the E major chord, its arms
 * uncurling from the vortex's curl, squashing gently and settling, as the
 * camera pulls back. The tagline shot: the lockup at the top, the tagline
 * building beneath, and the Devil's last ember drifting into the dot on 74,
 * where the mark clicks round one arm.
 */
export function markShot(g: G, ctx: Ctx, time: number, shot: EndShot): void {
  const pal = brandPalette(ctx);
  const place = markPlace(shot);
  ground(g, time, pal, place.y);
  const land = bf(69);
  const last = bf(LAST_EMBER_BEAT);
  // The arms uncurl on a smooth ease and the turn is slow, so the red never swings fast
  // enough to flicker or to smear into a double image under motion blur (WCAG 2.3.1).
  const open = smooth(prog(time, land, land + 40));
  const curl = shot === 'mark' ? lerp(2.2, 0.77, open) : 0.77;
  const click = springOf(time, last, SNAPPY) * (TAU / 6);
  const spin = VORTEX_END + 0.35 * open + (time - land) * 0.002 + click;
  const swallow = env(time, [last], 6);
  const hit = (at: number, amount: number): number => {
    // Clamped at the hit, so a motion-blur sub-frame just before it draws the same squash, not a second image.
    const t = Math.max(0, time - at) / 60;
    return time < at - 1 ? 0 : amount * Math.exp(-5 * t) * Math.cos(2 * Math.PI * 1.6 * t);
  };
  const sq = shot === 'mark' ? hit(land, 0.12) : hit(last, 0.08);
  const cam =
    shot === 'mark'
      ? { z: Math.exp(Math.log(1.12) * (1 - smooth(prog(time, land, bf(72))))), x: 0 }
      : { z: 1 + 0.05 * smooth(prog(time, bf(72), bf(75))), x: 16 * Math.sin((time - bf(72)) / 50) };
  g.save();
  g.translate(CX + cam.x, H / 2);
  g.scale(cam.z, cam.z);
  g.translate(-CX, -H / 2);
  g.save();
  g.translate(place.x, place.y);
  g.rotate(time * 0.002);
  for (let i = 0; i < 24; i++) {
    g.rotate(TAU / 24);
    g.fillStyle = rgba(pal.key, 0.04 + 0.02 * Math.sin(time * 0.05 + i) + 0.03 * swallow);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(-18, -1300);
    g.lineTo(18, -1300);
    g.closePath();
    g.fill();
  }
  g.restore();
  if (time >= last) {
    const w = (time - last) / 40;
    if (w < 1) {
      g.strokeStyle = rgba(pal.key, 0.35 * (1 - w));
      g.lineWidth = 3;
      g.beginPath();
      g.arc(place.x, place.y, place.r * (1 + 2 * w), 0, TAU);
      g.stroke();
    }
  }
  g.save();
  g.translate(place.x, place.y);
  g.scale(1 + sq, 1 - sq);
  mark(g, 0, 0, place.r, pal.key, spin, curl, 1, 1 + 0.35 * swallow);
  g.restore();
  for (let i = 0; i < 30; i++) {
    const life = ((time - land) / 60) * (0.3 + 0.2 * hash(i, 61)) + hash(i, 62) * 0.5;
    if (life > 1) {
      continue;
    }
    const x = hash(i, 63) * W + Math.sin(time * 0.03 + i) * 30;
    const y = H - life * 900 - 100 * hash(i, 64);
    drawEmber(g, time + i * 13, x, y, 3, (1 - life) * 0.6);
  }
  if (shot === 'tagline') {
    const from = bf(72.5);
    if (time >= from && time < last) {
      for (let trail = 5; trail >= 0; trail--) {
        const kt = smooth(prog(time - trail * 3, from, last));
        drawEmber(g, time, lerp(940, place.x, kt) + Math.sin(kt * Math.PI) * 140, lerp(1500, place.y, kt), lerp(10, 5, kt) * (1 - trail / 7), 0.9 * (1 - trail / 6));
      }
    }
  }
  g.restore();
}
