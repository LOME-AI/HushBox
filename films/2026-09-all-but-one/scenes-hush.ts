import { drawDevil } from './devil.js';
import { drawEmber } from './fire.js';
import {
  CX,
  DEFAULT,
  H,
  HEAVY,
  INK,
  PLAYFUL,
  SNAPPY,
  TAU,
  W,
  bf,
  clamp,
  env,
  hash,
  lerp,
  mix,
  outCubic,
  prog,
  rgba,
  smooth,
  springOf,
} from './kit.js';
import { LEAKS } from './score.js';
import { archive, padlock } from './scenes-praise.js';
import { frameBox, imagery, padded } from './type.js';

import type { G, Palette } from './kit.js';
import type { LogoBox, LookContext, TextBox } from '../engine/look/index.js';

type Ctx = LookContext<'2d'>;

/** HushBox's world: the brand's charcoal and Signal Red, with the Devil's gold now a guest in it. */
export function brandPalette(ctx: Ctx): Palette {
  return {
    bg: hex(ctx.brand.background),
    line: '#8d8479',
    hot: hex(ctx.brand.foreground),
    key: hex(ctx.brand.brandRed),
    dim: '#2a2622',
  };
}

/** Daylight: HushBox's values shown on warm paper, Signal Red kept, the Devil drawn in dark ink. */
export function lightPalette(ctx: Ctx): Palette {
  return {
    bg: '#efe8dc',
    line: '#4a4038',
    hot: '#1c1714',
    key: hex(ctx.brand.brandRed),
    dim: '#d8cfc0',
  };
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
    throw new Error('2026-09-all-but-one: no 2D context to resolve a brand colour');
  }
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gg = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
  const out = `#${((r << 16) | (gg << 8) | b).toString(16).padStart(6, '0')}`;
  HEX.set(css, out);
  return out;
}
const HEX = new Map<string, string>();

export function ground(g: G, time: number, pal: Palette, glowY: number): void {
  g.fillStyle = pal.bg;
  g.fillRect(-200, -200, W + 400, H + 400);
  const grad = g.createRadialGradient(CX, glowY, 0, CX, glowY, 1000);
  grad.addColorStop(0, rgba(pal.key, 0.1));
  grad.addColorStop(1, rgba(pal.key, 0));
  g.fillStyle = grad;
  g.fillRect(-200, -200, W + 400, H + 400);
  const roll = Math.floor((time / 60) * 8);
  g.fillStyle = rgba(pal.hot, 0.035);
  for (let index = 0; index < 200; index++) {
    g.fillRect(hash(index * 2 + roll * 977, 5) * W, hash(index * 2 + 1 + roll * 977, 5) * H, 2, 2);
  }
}

/** A token of an AI company: a ring around a small abstract glyph, none of them a real mark. */
function token(
  g: G,
  {
    x,
    y,
    r,
    kind,
    stroke,
    fill,
  }: { x: number; y: number; r: number; kind: number; stroke: string; fill: string | null }
): void {
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
    case 0: {
      for (let index = 0; index < 6; index++) {
        const a = (index / 6) * TAU;
        g.lineTo(Math.cos(a) * s, Math.sin(a) * s);
      }
      g.closePath();
      break;
    }
    case 1: {
      g.moveTo(-s, s * 0.6);
      g.lineTo(0, -s);
      g.lineTo(s, s * 0.6);
      g.closePath();
      break;
    }
    case 2: {
      for (let index = 0; index < 4; index++) {
        const a = (index / 4) * Math.PI;
        g.moveTo(Math.cos(a) * s, Math.sin(a) * s);
        g.lineTo(-Math.cos(a) * s, -Math.sin(a) * s);
      }
      break;
    }
    case 3: {
      g.moveTo(-s, 0);
      g.bezierCurveTo(-s * 0.4, -s, s * 0.4, s, s, 0);
      break;
    }
    default: {
      g.rect(-s * 0.6, -s * 0.6, s * 1.2, s * 1.2);
    }
  }
  g.stroke();
  g.restore();
}

const TOKEN_COLS = 7;
const TOKEN_ROWS = 10;
/** The one token that turns red: HushBox. */
const ONE_INDEX = 4 * TOKEN_COLS + 3;

function tokenAt(index: number): [number, number] {
  const c = index % TOKEN_COLS;
  const r = Math.floor(index / TOKEN_COLS);
  return [CX + (c - (TOKEN_COLS - 1) / 2) * 134 + (r % 2) * 22, 720 + r * 118];
}

/** Beat 40-44: every AI company a gold token; in the silence they dim; on 42 one turns red. */
export function one(g: G, ctx: Ctx, time: number): void {
  const red = hex(ctx.brand.brandRed);
  g.fillStyle = '#030202';
  g.fillRect(-200, -200, W + 400, H + 400);
  const beats = [bf(36), bf(37)];
  const heart = env(Math.round(time), beats, 5);
  const turn = springOf(time, bf(41), PLAYFUL);
  const dimmed = prog(time, bf(36), bf(41));
  const [ox, oy] = tokenAt(ONE_INDEX);
  const zoom = 1 + 0.5 * smooth(prog(time, bf(41), bf(43)));
  g.save();
  g.translate(ox, oy);
  g.scale(zoom, zoom);
  g.translate(-ox, -oy);
  for (let index = 0; index < TOKEN_COLS * TOKEN_ROWS; index++) {
    if (index === ONE_INDEX) {
      continue;
    }
    const [x, y] = tokenAt(index);
    const away = turn > 0 ? outCubic(prog(time, bf(41), bf(43))) : 0;
    const dx = (x - ox) * away * 0.25;
    const dy = (y - oy) * away * 0.25;
    const alpha =
      lerp(0.95, 0.4, dimmed) *
      (1 - 0.7 * away) *
      (0.8 + 0.2 * hash(index + Math.floor(Math.round(time) / 6), 2));
    token(g, {
      x: x + dx,
      y: y + dy,
      r: 40 * (1 + 0.12 * heart),
      kind: index * 7 + 3,
      stroke: rgba(INK.line, alpha),
      fill: null,
    });
  }
  const s = 40 * (1 + 0.12 * heart + 0.9 * turn);
  const c = Math.round(time) >= bf(41) ? red : INK.line;
  // The hit squashes the token flat and wide, then it springs tall, wobbles and settles.
  const since = (time - bf(41)) / 60;
  const wobble = since >= 0 ? Math.exp(-6 * since) * Math.cos(2 * Math.PI * 3.4 * since) : 0;
  g.save();
  g.translate(ox, oy);
  g.rotate(0.25 * wobble * Math.sin(since * 9));
  g.scale(1 + 0.45 * wobble, 1 - 0.4 * wobble);
  token(g, {
    x: 0,
    y: 0,
    r: s,
    kind: 0,
    stroke: c,
    fill: Math.round(time) >= bf(41) ? rgba(red, 0.25) : null,
  });
  g.restore();
  if (Math.round(time) >= bf(41)) {
    g.strokeStyle = rgba(red, clamp(1 - (time - bf(41)) / 40));
    g.lineWidth = 4;
    g.beginPath();
    g.arc(ox, oy, s + (time - bf(41)) * 9, 0, TAU);
    g.stroke();
  }
  g.restore();
}

const NOISE = '▓▒░#%&@$*+=?<>/{}[]01ABCDEF';

/** A string scrambled from `at` frames, one character every `each` frames, re-rolling twelve times a second. */
function scrambled(
  text: string,
  { time, at, each, seed }: { time: number; at: number; each: number; seed: number }
): string {
  const roll = Math.floor((time / 60) * 6);
  return Array.from(text.matchAll(/./gsu), ([ch], index) =>
    ch === ' ' || Math.round(time) < at + index * each
      ? ch
      : (NOISE[Math.floor(hash(index * 13 + roll * 7 + seed, 9) * NOISE.length)] ?? '#')
  ).join('');
}

/** The Devil at the bottom of the frame, rising into view afraid. */
function fearful(
  g: G,
  {
    time,
    pal,
    y,
    scale,
    fear,
    jaw,
    line = INK.line,
  }: {
    time: number;
    pal: Palette;
    y: number;
    scale: number;
    fear: number;
    jaw: number;
    line?: string;
  }
): void {
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

/** Beats 44-48, one read: with the words the red ring closes, the message scrambles to cipher and a padlock snaps shut. */
export function encrypted(
  g: G,
  ctx: Ctx,
  { time, start, frame }: { time: number; start: number; frame: number }
): TextBox[] {
  const pal = brandPalette(ctx);
  ground(g, time, pal, 900);
  // One read at a time: the claim lands alone on 44, the flock's first secret slams in under it on 44.5 and
  // holds readable for a beat and a half, and on 46 the ring closes and the letters scramble.
  const arrive = bf(44.5);
  const lockAt = bf(46);
  const close = springOf(time, lockAt, HEAVY);
  const ringR = lerp(1100, 460, close);
  const bx = CX;
  // The bubble and its ring sit high; the claim lands under them.
  const by = 700;
  const boxes: TextBox[] = [];
  const t = Math.round(time);
  if (t >= arrive) {
    const since = t - arrive;
    const k = 1 + 0.25 * Math.exp(-since / 3);
    const squash = 1 - 0.28 * Math.exp(-since / 4) * Math.cos(since / 2.2);
    g.save();
    g.translate(bx, by);
    g.scale(k / squash, k * squash);
    g.translate(-bx, -by);
    g.fillStyle = mix(pal.bg, '#ffffff', 0.08);
    g.strokeStyle = pal.hot;
    g.lineWidth = 3;
    g.beginPath();
    g.roundRect(bx - 420, by - 70, 840, 140, 36);
    g.fill();
    g.stroke();
    boxes.push(
      imagery(g, ctx, {
        id: 'enc-secret',
        text: scrambled(LEAKS[0], { time: frame, at: lockAt, each: 1, seed: 3 }),
        x: bx - 385,
        y: by + 14,
        size: 36,
        face: 'mono',
        weight: 600,
        fill: pal.hot,
      })
    );
    g.restore();
  }
  // The ring's glyphs hold still until the message scrambles, then re-roll with it.
  const roll = frame < lockAt ? 0 : Math.floor(frame / 5);
  g.save();
  g.translate(bx, by);
  g.rotate(start * 0.01 + (time - start) * 0.006);
  g.strokeStyle = pal.key;
  g.lineWidth = 8;
  g.beginPath();
  g.arc(0, 0, ringR, 0, TAU);
  g.stroke();
  const glyphs = 48;
  for (let index = 0; index < glyphs; index++) {
    g.save();
    g.rotate((index / glyphs) * TAU);
    g.translate(0, -ringR - 26);
    boxes.push(
      imagery(g, ctx, {
        id: `ring-${String(index)}`,
        text: NOISE[Math.floor(hash(index + roll * 3, 17) * NOISE.length)] ?? '#',
        x: 0,
        y: 0,
        size: 26,
        face: 'mono',
        weight: 700,
        fill: rgba(pal.key, 0.8),
        align: 'center',
      })
    );
    g.restore();
  }
  g.restore();
  const lockShut = bf(46.5);
  if (frame >= lockShut) {
    // Gated on the frame, so both motion-blur samples draw it: most of the way shut on its frame, then it overshoots and settles.
    const k = 0.6 + 0.4 * springOf(t, lockShut, SNAPPY);
    padlock(g, { x: bx + 390, y: by - 70, s: 40 * k, color: pal.key });
    const since = t - lockShut;
    if (since < 10) {
      g.strokeStyle = rgba(pal.key, 0.6 * (1 - since / 10));
      g.lineWidth = 4;
      g.beginPath();
      g.arc(bx + 390, by - 70, 40 + since * 9, 0, TAU);
      g.stroke();
    }
  }
  return boxes;
}

/** Beats 50-54, one read: the words over a wall of cipher; on the hit a red lock snaps onto every drawer in a wave, and the camera tracks along the wall. */
export function unreadable(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  const pal = brandPalette(ctx);
  ground(g, time, pal, 1300);
  const track = -120 + 240 * smooth(prog(time, start, start + 120));
  g.save();
  g.translate(track, 0);
  const boxes = archive(g, ctx, {
    time,
    pal,
    options: {
      fillFrom: 0,
      top: 780,
      noise: true,
      lock: null,
      rows: 8,
    },
  });
  // The locks: each drawer's snaps on a frame later than the one to its left, a wave across the wall.
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 5; c++) {
      const at = start + c * 3 + r;
      if (Math.round(time) < at) {
        continue;
      }
      const k = springOf(time, at, SNAPPY);
      padlock(g, { x: CX - 440 + c * 176 + 146, y: 780 + r * 124 + 30, s: 12 * k, color: pal.key });
    }
  }
  g.restore();
  return boxes;
}

/** The Devil's gold lens: a ring and handle, the cipher it magnifies inside, reported as imagery. */
function lensAt(
  g: G,
  ctx: Ctx,
  { time, pal, lx, ly, r }: { time: number; pal: Palette; lx: number; ly: number; r: number }
): TextBox {
  g.save();
  g.beginPath();
  g.arc(lx, ly, r, 0, TAU);
  g.clip();
  g.fillStyle = mix(pal.bg, '#c9a14a', 0.4);
  g.fillRect(lx - r, ly - r, 2 * r, 2 * r);
  g.font = `700 46px ${ctx.fonts['mono'] ?? 'monospace'}`;
  g.fillStyle = rgba(DARK_GOLD, 0.9);
  // Enough rows and columns to fill the glass edge to edge.
  for (let row = 0; row < 9; row++) {
    let line = '';
    for (let c = 0; c < 17; c++) {
      line +=
        NOISE[
          Math.floor(
            hash(row * 31 + c + Math.floor((time / 60) * 6 + row / 7) * 5, 21) * NOISE.length
          )
        ] ?? '#';
    }
    if (!ctx.hideText) {
      g.fillText(line, lx - r, ly - r + 44 + row * 52);
    }
  }
  // The cipher shows only through the glass, so its box is the glass's.
  const t = g.getTransform();
  const noise: TextBox = {
    id: 'lens-noise',
    text: 'cipher',
    box: padded(frameBox(t, { x0: lx - r, y0: ly - r, x1: lx + r, y1: ly + r })),
    fontSizePx: 46 * Math.hypot(t.a, t.b),
    role: 'imagery',
  };
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
  return noise;
}

/** Beats 54-56, one read: the Devil swings his lens up, it holds only noise, NO KEY springs up, and he recoils. */
export function lens(g: G, ctx: Ctx, time: number, start: number): TextBox[] {
  const pal = lightPalette(ctx);
  ground(g, time, pal, 1200);
  const recoil = springOf(time, bf(55), DEFAULT);
  fearful(g, {
    time,
    pal,
    y: 1320 + 40 * recoil,
    scale: 360 * (1 - 0.06 * recoil),
    fear: 0.55 + 0.3 * clamp(recoil),
    jaw: 0.2 + 0.4 * clamp(recoil),
    line: DARK_GOLD,
  });
  const up = clamp(springOf(time, start - 4, DEFAULT), 0, 1.15);
  const lx = lerp(1200, 560, up) + 30 * Math.sin((time - start) / 25);
  const ly = lerp(1700, 1120, up);
  const boxes: TextBox[] = [lensAt(g, ctx, { time, pal, lx, ly, r: 210 })];
  if (Math.round(time) >= bf(55)) {
    // Half its size on its frame, so the readout is there on the hit, then it springs to full.
    const k = 0.55 + 0.45 * springOf(Math.round(time) + 1, bf(55), SNAPPY);
    g.save();
    g.translate(lx, ly + 300);
    g.scale(k, k);
    g.fillStyle = mix(pal.bg, '#ffffff', 0.7);
    g.fillRect(-150, -52, 300, 76);
    g.strokeStyle = DARK_GOLD;
    g.lineWidth = 4;
    g.strokeRect(-150, -52, 300, 76);
    boxes.push(
      imagery(g, ctx, {
        id: 'lens-readout',
        text: 'NO KEY',
        x: 0,
        y: 0,
        size: 48,
        face: 'mono',
        weight: 800,
        fill: DARK_GOLD,
        align: 'center',
        tracking: 0.2,
      })
    );
    g.restore();
  }
  return boxes;
}

/** Beats 48-50: extreme close on the Devil's eyes; on the hit they snap wide and his head jerks back; on 49 he winces. */
export function flinch(g: G, ctx: Ctx, time: number, start: number): void {
  const pal = lightPalette(ctx);
  ground(g, time, pal, 900);
  const jerk = springOf(time, start, SNAPPY);
  const scale = 950 * (1 - 0.1 * clamp(jerk, 0, 1.2)) + (time - start) * 0.8;
  const y = 1140 + 50 * clamp(jerk, 0, 1.2);
  drawDevil(g, time, {
    x: CX + 20,
    y,
    scale,
    draw: 1,
    // On 49 the wince: the lids squeeze, the brows knot, the mouth pulls tight.
    mood: lerp(lerp(-0.4, -0.85, clamp(jerk)), -1, clamp(springOf(time, bf(49), SNAPPY))),
    jaw: lerp(0.3, 0.08, clamp(springOf(time, bf(49), SNAPPY))),
    lids: lerp(1, 0.45, clamp(springOf(time, bf(49), SNAPPY))),
    tremble: 0.004 + 0.01 * clamp(springOf(time, bf(49), SNAPPY)),
    horns: 1,
    line: DARK_GOLD,
    eye: INK.key,
    fill: pal.bg,
    lineWidth: 7,
    look: 0.15 * Math.sin((time - start) / 9),
    tilt: -0.05 * clamp(jerk),
  });
}

/** Radians a frame the vortex turns: slow enough that its red never flickers (WCAG 2.3.1 red flashes). */
const VORTEX_RATE = 0.03;
/** The mark shot's camera zoom on its first frame: the scream's dot is drawn where this puts the mark's dot. */
const MARK_PULL = 1.18;

/** Beats 60-63: the Devil screams, and his strokes tear loose into a red spiral. */
export function notHushbox(
  g: G,
  ctx: Ctx,
  { time, start, frame }: { time: number; start: number; frame: number }
): void {
  const pal = brandPalette(ctx);
  ground(g, time, pal, 1150);
  // On 62.5 everything collapses on its frame to one red dot, which holds in the silence.
  if (frame >= bf(62.5)) {
    // Drawn in screen space, where the mark will burst from on the next cut.
    const pulse = 1 + 0.12 * Math.sin((time - bf(62.5)) / 2);
    const place = markPlace();
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = pal.key;
    g.beginPath();
    g.arc(place.x, H / 2 + (place.y - H / 2) * MARK_PULL, 34 * pulse, 0, TAU);
    g.fill();
    g.restore();
    return;
  }
  const shatter = smooth(prog(time, bf(62), bf(62.5)));
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
    for (let index = 0; index <= 30; index++) {
      const s = index / 30;
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
    scale: (340 + (time - start) * 0.8) * (Math.round(time) < bf(61) ? 0.95 : 1),
    draw: 1,
    mood: -1,
    jaw:
      Math.round(time) < bf(61)
        ? 0.1
        : clamp(springOf(time, bf(61), SNAPPY), 0, 1.1) * (0.85 + 0.15 * Math.sin(time * 0.6)),
    look: Math.round(time) < bf(61) ? 0 : -0.4,
    tilt: Math.round(time) < bf(61) ? 0.06 : -0.04,
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

/** Where the end card's mark sits, as its centre and its drawn size in px (the logo file's width). */
export function markPlace(): { x: number; y: number; size: number } {
  return { x: CX, y: 600, size: 420 };
}

/** The beat the mark comes to rest: from here to the end the card holds still. */
export const MARK_REST_BEAT = 64.5;

interface MarkPart {
  path: Path2D;
  /** The part's centroid in the logo file's pixel space. */
  cx: number;
  cy: number;
  /** True for the centre dot: the part nearest the file's centre. */
  dot: boolean;
}

/** The logo's traced parts from `ctx.logo`, each with its centroid. */
function logoParts(ctx: Ctx): MarkPart[] {
  const { logo } = ctx;
  const parts = logo.parts.map((part) => {
    const n = Math.max(1, part.outline.length);
    const cx = part.outline.reduce((sum, p) => sum + p.x, 0) / n;
    const cy = part.outline.reduce((sum, p) => sum + p.y, 0) / n;
    return { path: part.path, cx, cy, dot: false };
  });
  const off = (part: MarkPart): number =>
    Math.hypot(part.cx - logo.width / 2, part.cy - logo.height / 2);
  let dot: MarkPart | undefined;
  for (const part of parts) {
    if (dot === undefined || off(part) < off(dot)) {
      dot = part;
    }
  }
  if (dot !== undefined) {
    dot.dot = true;
  }
  return parts;
}

/**
 * The mark, from the logo's own traced parts. Each part is carried by `pose(i)`:
 * `w` its arrival (0 at the dot, 1 exactly at rest), `push` a radial nudge in
 * logo pixels. At w = 1 and push = 0 every part is drawn at the file's own
 * place, so the mark at rest is the logo exactly.
 */
export function drawMarkParts(
  g: G,
  ctx: Ctx,
  {
    place,
    color,
    pose,
  }: {
    place: { x: number; y: number; size: number };
    color: string;
    pose: (index: number, dot: boolean) => { w: number; push: number; spin: number };
  }
): void {
  const k = place.size / ctx.logo.width;
  const mx = ctx.logo.width / 2;
  const my = ctx.logo.height / 2;
  g.save();
  g.translate(place.x - mx * k, place.y - my * k);
  g.scale(k, k);
  g.fillStyle = color;
  for (const [index, part] of logoParts(ctx).entries()) {
    const { w, push, spin } = pose(index, part.dot);
    const dx = part.cx - mx;
    const dy = part.cy - my;
    const length = Math.hypot(dx, dy) || 1;
    // Where the part's centroid is now: swung round the centre from the dot out to its place.
    const a = spin * (1 - w);
    const r = w;
    const px = mx + (dx * Math.cos(a) - dy * Math.sin(a)) * r + (dx / length) * push;
    const py = my + (dx * Math.sin(a) + dy * Math.cos(a)) * r + (dy / length) * push;
    const scale = 0.25 + 0.75 * Math.min(1.15, w);
    g.save();
    g.translate(px, py);
    g.rotate(a);
    g.scale(scale, scale);
    g.translate(-part.cx, -part.cy);
    g.fill(part.path);
    g.restore();
  }
  g.restore();
}

/**
 * The mark at rest, exactly the logo, filled in `color` at `place`, and its box as the logo gate
 * reads it: the whole logo image's box, transparent margin included, through the current
 * transform. Only a transform of scale and translation keeps that box exact, so callers draw it
 * with no roll.
 */
export function markAtRest(
  g: G,
  ctx: Ctx,
  { place, color, id }: { place: { x: number; y: number; size: number }; color: string; id: string }
): LogoBox {
  drawMarkParts(g, ctx, { place, color, pose: () => ({ w: 1, push: 0, spin: 0 }) });
  const k = place.size / ctx.logo.width;
  const x0 = place.x - (ctx.logo.width / 2) * k;
  const y0 = place.y - (ctx.logo.height / 2) * k;
  const m = g.getTransform();
  const a = m.transformPoint({ x: x0, y: y0 });
  const b = m.transformPoint({ x: x0 + ctx.logo.width * k, y: y0 + ctx.logo.height * k });
  return {
    id,
    box: {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    },
    role: 'logo',
  };
}

/**
 * Beats 63-75, the end card. The red dot bursts, and each part of the mark
 * flies out from it on its own arc and settles exactly on the logo as the
 * camera pulls back; the wordmark lands on 64 and the tagline on 64.5. From
 * 64.5 the camera and every part are at rest and the card holds still to the
 * end: the mark is the logo exactly, the rays turn slowly, embers drift.
 */
export function markShot(g: G, ctx: Ctx, time: number): LogoBox[] {
  const pal = brandPalette(ctx);
  const place = markPlace();
  ground(g, time, pal, place.y);
  const land = bf(63);
  const rest = bf(MARK_REST_BEAT);
  const settle = smooth(prog(time, land, rest));
  const at = Math.round(time) >= rest;
  const cam = at
    ? { z: 1, x: 0, r: 0 }
    : {
        z: Math.exp(Math.log(MARK_PULL) * (1 - settle)),
        x: 40 * Math.sin(Math.PI * settle),
        r: 0.02 * (1 - settle),
      };
  g.save();
  g.translate(CX + cam.x, H / 2);
  g.rotate(cam.r);
  g.scale(cam.z, cam.z);
  g.translate(-CX, -H / 2);
  g.save();
  g.translate(place.x, place.y);
  g.rotate(time * 0.0015);
  for (let index = 0; index < 24; index++) {
    g.rotate(TAU / 24);
    g.fillStyle = rgba(pal.key, 0.04 + 0.015 * Math.sin(time * 0.03 + index));
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(-18, -1300);
    g.lineTo(18, -1300);
    g.closePath();
    g.fill();
  }
  g.restore();
  if (Math.round(time) < land + 30) {
    // The burst: a ring thrown off the dot.
    const w = (time - land) / 30;
    g.strokeStyle = rgba(pal.key, 0.5 * (1 - w));
    g.lineWidth = 6;
    g.beginPath();
    g.arc(place.x, place.y, 40 + place.size * 0.8 * w, 0, TAU);
    g.stroke();
  }
  for (let index = 0; index < 30; index++) {
    // Embers keep rising behind the card, each on its own slow cycle.
    const cycle = ((time - land) / 60) * (0.2 + 0.15 * hash(index, 61)) + hash(index, 62);
    const life = cycle - Math.floor(cycle);
    const x = hash(index, 63) * W + Math.sin(time * 0.02 + index) * 30;
    const y = H - life * 900 - 100 * hash(index, 64);
    drawEmber(g, { time: time + index * 13, x, y, r: 3, heat: (1 - life) * 0.5 });
  }
  const logos: LogoBox[] = [];
  if (at) {
    logos.push(markAtRest(g, ctx, { place, color: pal.key, id: 'end-mark' }));
  } else {
    drawMarkParts(g, ctx, {
      place,
      color: pal.key,
      pose: (index, dot) => {
        // Each arc flies out on its own delay; the dot is there from the burst.
        const w = dot ? 1 : Math.max(0, springOf(time, land + 1 + index * 1.5, SNAPPY));
        return { w, push: 0, spin: 1.4 + 0.25 * (index % 3) };
      },
    });
  }
  g.restore();
  return logos;
}
