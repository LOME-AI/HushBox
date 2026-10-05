import {
  CHASE_BEATS,
  CHEER,
  HEAP,
  STRANGER_FROM,
  STRANGER_LOOK,
  DIVE,
  JOY,
  LIGHTS,
  NOTE,
  OPEN_BEATS,
  OUTSIDE,
  PEEL_BEATS,
  SOON_OUT,
  SHEET_BEATS,
  SIGN_NAME,
  SIGN_THE,
  SOURCES,
  STEP_BACK,
  TRACE_BEATS,
  bf,
} from './beats.js';
import { drawMark, hex } from './brand.js';
import { ARMS_UP, CALM, LOOK_UP, STAND, blend, blinking, figure, walk } from './figure.js';
import { drawHeap } from './heap.js';
import { CX, DEFAULT, H, HEAVY, P, PLAYFUL, SNAPPY, W, boil, clamp, env, hash, hs, inCubic, lerp, mix, outBack, outCubic, prog, rgba, smooth, springOf, wander } from './kit.js';
import { lamp, nightSky } from './persp.js';
import { camLerp, camera } from './scenes-night.js';
import { fontOf, glyph, metric, screenBox, screenScale, textLine, unionBox } from './type.js';

import type { Face, Pose } from './figure.js';
import type { G } from './kit.js';
import type { Cam } from './scenes-night.js';
import type { Ctx } from './type.js';
import type { LookBox, TextBox } from '../../../../engine/look/index.js';

/** The facade, in its own world: the sign, the letter board under it, the glass doors, the pavement. */
const F = {
  sign: { x0: 130, x1: 950, y0: 420, y1: 700 },
  board: { x0: 170, x1: 910, y0: 730, y1: 900 },
  doors: { y0: 950, y1: 1560 },
  doorX: [
    [190, 530],
    [550, 890],
  ],
  pane: [
    [990, 1250],
    [1272, 1520],
  ],
  ground: 1560,
} as const;

/** Each pane: door d (0 left, 1 right), row r (0 upper, 1 lower), as a rectangle. */
function paneRect(k: number): { x0: number; x1: number; y0: number; y1: number } {
  const d = k % 2;
  const r = Math.floor(k / 2);
  const [dx0, dx1] = F.doorX[d] ?? [190, 530];
  const [py0, py1] = F.pane[r] ?? [990, 1250];
  return { x0: dx0 + 26, x1: dx1 - 26, y0: py0, y1: py1 };
}

/** The two sheets, one per door, tall over both its panes; seen from the street they meet across the doors' gap. */
function sheetRect(k: number): { x0: number; x1: number; y0: number; y1: number } {
  const top = paneRect(0).y0 - 14;
  const bottom = paneRect(2).y1;
  return k === 0 ? { x0: paneRect(0).x0, x1: CX + 3, y0: top, y1: bottom } : { x0: CX, x1: paneRect(1).x1, y0: top, y1: bottom };
}

/** A rectangle drawn as one stretched capital I, the face's filled bar. */
function bar(g: G, ctx: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, alpha = 1): void {
  const font = fontOf(ctx, 'sans', 900, 200);
  const m = metric(g, font, 'I');
  const w = m.left + m.right;
  const h = m.ascent + m.descent;
  g.save();
  g.translate(x0, y0);
  g.scale((x1 - x0) / w, (y1 - y0) / h);
  g.font = font;
  g.globalAlpha *= alpha;
  g.fillStyle = color;
  g.fillText('I', m.left, m.ascent);
  g.restore();
}

/** The bulbs round the sign, clockwise from its top-left corner. */
const BULBS: readonly { x: number; y: number }[] = (() => {
  const inset = 24;
  const x0 = F.sign.x0 + inset;
  const x1 = F.sign.x1 - inset;
  const y0 = F.sign.y0 + inset;
  const y1 = F.sign.y1 - inset;
  const step = 46;
  const out: { x: number; y: number }[] = [];
  for (let x = x0; x < x1; x += step) out.push({ x, y: y0 });
  for (let y = y0; y < y1; y += step) out.push({ x: x1, y });
  for (let x = x1; x > x0; x -= step) out.push({ x, y: y1 });
  for (let y = y1; y > y0; y -= step) out.push({ x: x0, y });
  return out;
})();

/** The frame bulb b appears as the image model draws the sign: round the frame over six sixteenths. */
function bulbAt(b: number): number {
  const first = bf(TRACE_BEATS[0] ?? 35);
  const last = bf((TRACE_BEATS.at(-1) ?? 36.25) + 0.25);
  return first + Math.floor(((last - first) * b) / BULBS.length);
}

interface SignState {
  /** Bulbs drawn: those whose frame has come. */
  traced: boolean;
  lights: number;
  chase: boolean;
}

function signText(g: G, ctx: Ctx, frame: number, time: number): void {
  const slam = (at: number, word: string, y: number, size: number, color: string): void => {
    if (frame < at) {
      return;
    }
    const t = Math.round(time) - at;
    // Down from oversize, flattened on the hit, then up past full height and settled: heavy type.
    const s = 1 + 0.9 * Math.exp(-t / 2.2) * (t < 3 ? 1 : 0.2);
    const squash = t >= 0 && t < 14 ? Math.exp(-t / 3.5) * Math.cos(t * 0.6) : 0;
    g.save();
    g.translate(CX, y);
    g.scale(s * (1 + 0.18 * squash), s * (1 - 0.22 * squash));
    textLine(g, ctx, word, 0, 0, { face: 'sans', weight: 900, size, color, align: 'center', tracking: 0.06 }, null);
    g.restore();
  };
  slam(bf(SIGN_THE), 'THE', 534, 88, P.cream);
  slam(bf(SIGN_NAME), 'LANTERN', 664, 124, P.amberHot);
}

function drawSign(g: G, ctx: Ctx, frame: number, time: number, s: SignState): void {
  bar(g, ctx, F.sign.x0, F.sign.y0, F.sign.x1, F.sign.y1, '#120f28');
  const chaseStep = Math.floor((time - bf(CHASE_BEATS[0] ?? 38.5)) / 14);
  BULBS.forEach((p, b) => {
    const at = bulbAt(b);
    if (s.traced && frame < at) {
      return;
    }
    const pop = s.traced ? outBack(prog(time, at, at + 7), 2.5) : 1;
    const chased = s.chase && chaseStep >= 0 && (b + chaseStep) % 3 === 0;
    const on = s.lights * (chased ? 1 : 0.72);
    if (on > 0) {
      const r = 34;
      const halo = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      halo.addColorStop(0, rgba(P.amberHot, 0.6 * on));
      halo.addColorStop(1, rgba(P.amber, 0));
      g.fillStyle = halo;
      g.fillRect(p.x - r, p.y - r, 2 * r, 2 * r);
    }
    glyph(g, ctx, 'o', p.x, p.y, 34 * pop, { face: 'sans', weight: on > 0 ? 900 : 500, color: on > 0 ? mix(P.amber, P.amberHot, on) : P.cream });
  });
  // The pen: a spark at the head of the trace while the model draws.
  const traceEnd = bulbAt(BULBS.length);
  if (s.traced && frame >= bulbAt(0) && frame < traceEnd) {
    const head = BULBS[Math.min(BULBS.length - 1, Math.floor(((time - bulbAt(0)) / (traceEnd - bulbAt(0))) * BULBS.length))];
    if (head !== undefined) {
      glyph(g, ctx, '+', head.x, head.y, 70, { face: 'sans', weight: 300, color: P.amberHot, rot: time * 0.2 });
    }
  }
  signText(g, ctx, frame, time);
}

/** The board's letters: where each of O, P, E, N is set, its state at this frame. */
function boardSlot(k: number): { x: number; y: number } {
  return { x: CX + (k - 1.5) * 118, y: 815 };
}

const OPEN = 'OPEN';

function drawBoard(g: G, ctx: Ctx, frame: number, time: number, letters: boolean, report: boolean): TextBox[] {
  bar(g, ctx, F.board.x0, F.board.y0, F.board.x1, F.board.y1, '#0f0d1c');
  for (const y of [762, 815, 868]) {
    for (let x = F.board.x0 + 30; x < F.board.x1 - 20; x += 40) {
      glyph(g, ctx, '—', x, y, 34, { face: 'sans', weight: 300, color: P.dim, alpha: 0.28 });
    }
  }
  if (!letters) {
    return [];
  }
  const boxes: TextBox['box'][] = [];
  const size = 128;
  [...OPEN].forEach((ch, k) => {
    const at = bf(OPEN_BEATS[k] ?? 52);
    if (frame < at) {
      return;
    }
    const t = Math.round(time) - at;
    const squash = t < 16 ? Math.exp(-t / 3.5) * Math.cos(t * 0.55) : 0;
    // Lands oversize, dips below full size, settles: an overshoot on every letter.
    const over = t < 20 ? 0.22 * Math.exp(-t / 4) * Math.cos(t * 0.45) : 0;
    const p = boardSlot(k);
    const joy = env(time, [bf(JOY)], 6);
    g.save();
    g.translate(p.x, p.y);
    g.scale((1 + over) * (1 + 0.2 * squash), (1 + over) * (1 - 0.25 * squash) + 0.04 * clamp(joy) * (k % 2 === 0 ? 1 : -1));
    const hide = report && ctx.hideText;
    if (!hide) {
      textLine(g, ctx, ch, 0, 0, { face: 'sans', weight: 900, size, color: P.cream, align: 'center' }, null);
    }
    const font = fontOf(ctx, 'sans', 900, size);
    const m = metric(g, font, ch);
    boxes.push(screenBox(g, -(m.left + m.right) / 2 - 2, -m.ascent, m.left + m.right + 4, m.ascent + m.descent));
    g.restore();
  });
  if (!report || boxes.length < OPEN.length) {
    return [];
  }
  return [{ id: 'open', text: OPEN, box: unionBox(boxes), fontSizePx: size * screenScale(g), role: 'headline' }];
}

/** The hall behind the glass: dark at night, warm and lit once it is open, the heap low at the left. */
function interior(g: G, ctx: Ctx, frame: number, time: number, lit: number): void {
  const x0 = F.doorX[0][0];
  const x1 = F.doorX[1][1];
  g.save();
  g.beginPath();
  g.rect(x0, F.doors.y0, x1 - x0, F.doors.y1 - F.doors.y0);
  g.clip();
  const grad = g.createLinearGradient(0, F.doors.y0, 0, F.doors.y1);
  grad.addColorStop(0, mix('#0b0c22', '#ffcf86', lit * 0.85));
  grad.addColorStop(1, mix('#080918', '#7a4a6a', lit * 0.6));
  g.fillStyle = grad;
  g.fillRect(x0, F.doors.y0, x1 - x0, F.doors.y1 - F.doors.y0);
  // The screen, far in, and the rows' tops in front of it.
  bar(g, ctx, 380, 1010, 700, 1120, mix('#24224d', P.cream, lit), 0.9);
  for (let r = 0; r < 4; r++) {
    const y = 1220 + r * 70;
    const s = 34 + r * 12;
    const n = 7 + r * 2;
    for (let i = 0; i < n; i++) {
      glyph(g, ctx, 'n', CX + (i - (n - 1) / 2) * s * 1.05, y, s, { face: 'sans', weight: 800, color: mix(P.violet, P.violetHi, lit), anchor: 'bottom' });
    }
  }
  drawHeap(g, ctx, frame, time, { x: 330, y: F.doors.y1 - 6, unit: 22, count: HEAP.total, shade: 0.25 * (1 - lit) });
  g.restore();
}

function doorFrames(g: G, ctx: Ctx, tone: string): void {
  for (const [x0, x1] of F.doorX) {
    bar(g, ctx, x0, F.doors.y0, x0 + 26, F.doors.y1, tone);
    bar(g, ctx, x1 - 26, F.doors.y0, x1, F.doors.y1, tone);
    bar(g, ctx, x0, F.doors.y0, x1, F.doors.y0 + 40, tone);
    bar(g, ctx, x0, F.pane[0][1], x1, F.pane[1][0], tone);
    bar(g, ctx, x0, F.doors.y1 - 40, x1, F.doors.y1, tone);
  }
  bar(g, ctx, F.doorX[0][1], F.doors.y0, F.doorX[1][0], F.doors.y1, tone);
  glyph(g, ctx, 'l', 518, 1398, 78, { face: 'sans', weight: 700, color: '#d9a04a' });
  glyph(g, ctx, 'l', 562, 1398, 78, { face: 'sans', weight: 700, color: '#d9a04a' });
}

/** The building round the doors and sign: a wall, two pillars and a cornice of equals signs. */
function building(g: G, ctx: Ctx, dawn: number): void {
  bar(g, ctx, 40, 300, 1040, F.ground, mix('#17173c', '#3c3058', dawn));
  bar(g, ctx, 40, 300, 120, F.ground, mix('#25245e', '#5a4672', dawn));
  bar(g, ctx, 960, 300, 1040, F.ground, mix('#25245e', '#5a4672', dawn));
  for (let x = 40; x < 1050; x += 52) {
    glyph(g, ctx, '=', x + 26, 330, 64, { face: 'mono', weight: 700, color: mix(P.lilac, P.amberHot, dawn), alpha: 0.6 });
  }
}

/** The pavement and street in front: a kerb of equals signs and the sources laid as paving. */
function pavement(g: G, ctx: Ctx, time: number, dawn: number, words = 1): void {
  const grad = g.createLinearGradient(0, F.ground, 0, F.ground + 700);
  grad.addColorStop(0, mix('#1c1d48', '#6d5a72', dawn));
  grad.addColorStop(1, mix('#0a0b20', '#3b3050', dawn));
  g.fillStyle = grad;
  g.fillRect(-300, F.ground, W + 600, 1200);
  for (let x = -40; x < W + 60; x += 46) {
    glyph(g, ctx, '=', x, F.ground + 40, 60, { face: 'mono', weight: 700, color: P.lilac, alpha: 0.55, sy: 0.7 });
  }
  SOURCES.forEach((text, k) => {
    const row = Math.floor(k / 4);
    const col = k % 4;
    const y = F.ground + 130 + row * 110;
    const x = 140 + col * 270 + (row % 2) * 60;
    glyph(g, ctx, `[ ${text} ]`, x, y, 34 + row * 6, { face: 'mono', weight: 600, color: P.cream, alpha: (0.38 + 0.08 * row) * words, sy: 0.55 });
  });
  void time;
}

function dawnSky(g: G, ctx: Ctx, time: number, dawn: number): void {
  if (dawn < 1) {
    nightSky(g, ctx, time, F.ground, { moonX: 880, moonY: 200 });
  }
  if (dawn > 0) {
    const grad = g.createLinearGradient(0, -300, 0, F.ground);
    grad.addColorStop(0, rgba(P.dawnTop, dawn));
    grad.addColorStop(0.55, rgba(P.dawnMid, dawn));
    grad.addColorStop(1, rgba(P.dawnLow, dawn));
    g.fillStyle = grad;
    g.fillRect(-300, -600, W + 600, F.ground + 600);
  }
}

function lamps(g: G, ctx: Ctx, time: number, glow: number): void {
  const flick = 0.85 + 0.15 * wander(time / 30, 3);
  lamp(g, ctx, 20, F.ground + 10, 230, 1, false, glow * flick);
  lamp(g, ctx, 1060, F.ground + 10, 230, 1, true, glow * flick);
}

// ---------------------------------------------------------------- shots

/** Beats 36–39: Seedream 5.0 draws the sign: bulbs round its frame on the sixteenths, then THE and LANTERN slam in. */
export function sign(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const u = prog(time, bf(36), bf(39));
  g.save();
  camera(g, camLerp({ x: CX, y: 600, z: 1 }, { x: CX, y: 580, z: 1.05 }, smooth(u)));
  dawnSky(g, ctx, time, 0);
  building(g, ctx, 0);
  drawSign(g, ctx, frame, time, { traced: true, lights: 0, chase: false });
  drawBoard(g, ctx, frame, time, false, false);
  g.restore();
  const plate = textLine(g, ctx, 'Seedream 5.0', 110, 372, { face: 'mono', weight: 600, size: 36, color: P.teal }, { id: 'sign-model', words: 'Seedream 5.0', role: 'imagery' });
  return plate === null ? [] : [plate];
}

/** Beats 39–42: the camera pulls back off the sign to the cinema on its street; the bulbs light and chase; she cheers, one arm then the other. */
export function facadeShot(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const pull = springOf(time, bf(LIGHTS), HEAVY);
  const drift = prog(time, bf(40), bf(42));
  const cam = camLerp({ x: CX, y: 580, z: 1.05 }, { x: CX + 10 * drift, y: 1010 - 20 * drift, z: 0.86 + 0.03 * drift }, clamp(pull, 0, 1.08));
  g.save();
  camera(g, cam);
  dawnSky(g, ctx, time, 0);
  building(g, ctx, 0);
  interior(g, ctx, frame, time, 0.15);
  doorFrames(g, ctx, '#2c2a66');
  drawSign(g, ctx, frame, time, { traced: false, lights: clamp(env(time, [bf(LIGHTS)], 10) + 0.85), chase: frame >= bf(CHASE_BEATS[0] ?? 39.5) });
  drawBoard(g, ctx, frame, time, false, false);
  pavement(g, ctx, time, 0);
  lamps(g, ctx, time, 1);
  figure(g, ctx, 470, F.ground + 70, 170, cheer(time, bf(CHEER), LOOK_UP));
  g.restore();
  return [];
}

/** Her cheer from `from`: one arm goes up on the beat, the other follows five frames later and further out; she hops. */
function cheer(time: number, at: number, from: Pose): Pose {
  const first = clamp(springOf(time, at, PLAYFUL), 0, 1.15);
  const second = clamp(springOf(time, at + 5, PLAYFUL), 0, 1.15);
  // The arms spring and overshoot; her body and head settle in six frames and hold, so her face reads still.
  const lean = blend(from, ARMS_UP, smooth(prog(time, at, at + 6)));
  return {
    ...lean,
    handL: [lerp(from.handL[0], ARMS_UP.handL[0], first), lerp(from.handL[1], ARMS_UP.handL[1], first)],
    handR: [lerp(from.handR[0], ARMS_UP.handR[0], second), lerp(from.handR[1], ARMS_UP.handR[1], second)],
    squash: -0.1 * clamp(env(time, [at], 2.5)),
    face: first > 0.4 ? (ARMS_UP.face ?? CALM) : { eyes: 'wide', mouth: 'o', brow: -0.1, look: [0, -1], raise: 0.8 },
  };
}

/** What each sheet carries, facing her: one big line to read, the rest of the conversation small under it. */
const SHEETS: readonly { big: readonly string[]; small: readonly string[] }[] = [
  { big: ['how do I open', 'a cinema?'], small: ['Gemini 3.1 Pro', 'Searched the web', '· 12 sources', 'permits, leases,', 'projectors, licences', '', 'A nnnnnnnn', 'B nnnnnnnnnn', 'C nnnnnnnnnn'] },
  { big: ['The', 'Lantern'], small: ['what do I call it?', 'Gemini 3.1 Pro', '', 'Seedream 5.0', 'THE LANTERN', '', 'Claude Sonnet 5.5', 'rows = [8, 10, 10, 12]', 'print(r, "n" * n)'] },
];

/** A sheet of the conversation, printed side facing in: its big line, then the rest, all inside the paper. */
function sheetFront(g: G, ctx: Ctx, k: number, r: { x0: number; x1: number; y0: number; y1: number }): void {
  bar(g, ctx, r.x0, r.y0, r.x1, r.y1, P.paper);
  const sheet = SHEETS[k];
  if (sheet === undefined) {
    return;
  }
  const big = k === 0 ? { face: 'mono' as const, weight: 700, size: 32 } : { face: 'sans' as const, weight: 800, size: 54 };
  let y = r.y0 + 66;
  for (const line of sheet.big) {
    textLine(g, ctx, line, r.x0 + 20, y, { ...big, color: k === 0 ? P.inkDark : '#c45f00' }, null);
    y += big.size * 1.2;
  }
  y += 22;
  for (const line of sheet.small) {
    textLine(g, ctx, line, r.x0 + 20, y, { face: 'mono', weight: 600, size: 19, color: '#4a4560' }, null);
    y += 30;
  }
}

/** Beats 42–45: inside at night, she papers each door with a tall sheet of the conversation, writing facing her, and steps back. */
export function papering(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const u = prog(time, bf(42), bf(45));
  g.fillStyle = '#07081a';
  g.fillRect(0, 0, W, H);
  g.save();
  camera(g, camLerp({ x: CX + 30, y: 1240, z: 1.12 }, { x: CX - 30, y: 1210, z: 1.24 }, smooth(u)));
  // Through the glass: the night street, a lamp's glow and stars.
  const x0 = F.doorX[0][0];
  const x1 = F.doorX[1][1];
  const out = g.createLinearGradient(0, F.doors.y0, 0, F.doors.y1);
  out.addColorStop(0, '#141a44');
  out.addColorStop(1, '#2a2350');
  g.fillStyle = out;
  g.fillRect(x0, F.doors.y0, x1 - x0, F.doors.y1 - F.doors.y0);
  for (let k = 0; k < 14; k++) {
    glyph(g, ctx, k % 3 === 0 ? '*' : '·', x0 + hash(k, 111) * (x1 - x0), F.doors.y0 + hash(k, 112) * 300, 30, { face: 'sans', weight: 600, color: P.cream, alpha: 0.4 + 0.3 * Math.sin(time * 0.05 + k) });
  }
  const halo = g.createRadialGradient(840, 1150, 0, 840, 1150, 260);
  halo.addColorStop(0, rgba(P.amber, 0.4));
  halo.addColorStop(1, rgba(P.amber, 0));
  g.fillStyle = halo;
  g.fillRect(x0, F.doors.y0, x1 - x0, F.doors.y1 - F.doors.y0);
  doorFrames(g, ctx, '#1d1c46');
  bar(g, ctx, -200, 700, x0, 2000, '#0d0d26');
  bar(g, ctx, x1, 700, 1300, 2000, '#0d0d26');
  bar(g, ctx, -200, 700, 1300, F.doors.y0, '#0d0d26');
  // The sheets: each flies in from her side, accelerating, and slaps flat onto its door on the beat.
  SHEET_BEATS.forEach((beat, k) => {
    const at = bf(beat);
    if (frame < at - 10) {
      return;
    }
    const r = paneRect(k);
    const rect = { x0: r.x0, x1: r.x1, y0: paneRect(0).y0 - 10, y1: paneRect(2).y1 };
    const fly = inCubic(prog(time, at - 10, at));
    const t = Math.round(time) - at;
    const squash = t >= 0 && t < 14 ? Math.exp(-t / 3) * Math.cos(t * 0.7) : 0;
    const cx = (rect.x0 + rect.x1) / 2;
    const cy = (rect.y0 + rect.y1) / 2;
    g.save();
    g.translate(lerp(1300, cx, fly), lerp(cy + 300, cy, fly));
    g.rotate((1 - fly) * 0.6 + hs(k, 113) * 0.015);
    g.scale(lerp(0.45, 1, fly) * (1 + 0.06 * squash), lerp(0.45, 1, fly) * (1 - 0.08 * squash));
    g.translate(-cx, -cy);
    sheetFront(g, ctx, k, rect);
    if (t >= 0) {
      glyph(g, ctx, '—', rect.x0 + 10, rect.y0 + 6, 70, { face: 'sans', weight: 800, color: P.amberHot, alpha: 0.6, rot: -0.6 });
      glyph(g, ctx, '—', rect.x1 - 10, rect.y0 + 6, 70, { face: 'sans', weight: 800, color: P.amberHot, alpha: 0.6, rot: 0.6 });
    }
    g.restore();
  });
  drawHeap(g, ctx, frame, time, { x: 150, y: 1700, unit: 34, count: HEAP.total, shade: 0.3 });
  // Her: she reaches up with each sheet, presses it flat, then steps back to look at it.
  const current = SHEET_BEATS.reduce((acc, beat, k) => (frame >= bf(beat) - 10 ? k : acc), 0);
  const reachPose: Pose = { ...STAND, handR: [current === 0 ? -0.55 : 0.1, -1.7], handL: [current === 0 ? -0.9 : -0.3, current === 0 ? -1.2 : -0.7], head: -0.25, lean: current === 0 ? -0.08 : 0.02, face: { eyes: 'dot', mouth: 'flat', brow: 0.3, look: [current === 0 ? -0.8 : -0.2, -1] } };
  const back = springOf(time, bf(STEP_BACK), DEFAULT);
  const pose = blend(reachPose, { ...LOOK_UP, face: { eyes: 'dot', mouth: 'smile', brow: -0.1, look: [-0.5, -0.8] } }, clamp(back));
  const herX = lerp(current === 0 ? 700 : 860, 960, clamp(back));
  figure(g, ctx, herX, 1760, 220, { ...pose, squash: 0.05 * clamp(env(time, SHEET_BEATS.map((b) => bf(b)), 3)), face: blinking(pose.face ?? CALM, time, 55) });
  g.restore();
  return [];
}

/** The papered doors from the street: blank paper, the spiral on the right sheet, each peeling from its top. */
function papersOutside(g: G, ctx: Ctx, time: number, peel: (k: number) => number): void {
  for (let k = 0; k < 2; k++) {
    const r = sheetRect(k);
    const p = peel(k);
    if (p >= 1) {
      continue;
    }
    const top = lerp(r.y0, r.y1, inCubic(p));
    g.save();
    g.beginPath();
    g.rect(r.x0 - 4, top, r.x1 - r.x0 + 8, r.y1 - top + 4);
    g.clip();
    bar(g, ctx, r.x0, r.y0, r.x1, r.y1, P.paper);
    for (let i = 0; i < 8; i++) {
      glyph(g, ctx, '-', r.x0 + 30 + hash(k * 10 + i, 121) * (r.x1 - r.x0 - 60), r.y0 + 30 + hash(k * 10 + i, 122) * (r.y1 - r.y0 - 60), 30, { face: 'sans', weight: 300, color: P.paperShade, alpha: 0.5 + 0.3 * boil(time, k * 10 + i, 4, 5) });
    }
    if (k === 1) {
      drawMark(g, ctx, { x: r.x1 - 80, y: r.y1 - 90, size: 96 }, hex(ctx.brand.brandRed), () => ({ w: 1, spin: 0 }));
    }
    g.restore();
    if (p > 0) {
      bar(g, ctx, r.x0, top - 18 * (1 - p), r.x1, top + 6, P.paperShade);
    }
  }
}

/** The clip of sheet k as it peels: what of it still covers the glass. */
function sheetClip(g: G, k: number, p: number): void {
  const r = sheetRect(k);
  const top = lerp(r.y0, r.y1, inCubic(p));
  g.beginPath();
  g.rect(r.x0 - 4, top, r.x1 - r.x0 + 8, r.y1 - top + 4);
  g.clip();
}

/** Where the note is taped: high on the left sheet, so it and the sign both sit inside the safe area. */
const NOTE_AT = { x: 368, y: 1338 };

/**
 * Beats 45–50: from the street, the doors are blank paper, a small red spiral and COMING SOON; a note is
 * taped on; on 48 a cut in to the note and the spiral; a stranger passes, looks, and sees nothing.
 */
export function outside(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const wide = frame < bf(SOON_OUT);
  const u = smooth(prog(time, bf(OUTSIDE), bf(SOON_OUT)));
  const drift = smooth(prog(time, bf(SOON_OUT), bf(50)));
  // Wide, a push in and down onto COMING SOON that keeps the whole sign in frame and the note inside the safe area;
  // the cut in on 48 pushes on and pans left with the stranger, the note held inside the safe area.
  const cam: Cam = wide
    ? camLerp({ x: 552, y: 1130, z: 1 }, { x: 540, y: 1215, z: 1.1 }, u)
    : camLerp({ x: 575, y: 1490, z: 1.2 }, { x: 480, y: 1450, z: 1.42 }, drift);
  g.save();
  camera(g, cam);
  dawnSky(g, ctx, time, 0);
  building(g, ctx, 0);
  interior(g, ctx, frame, time, 0);
  doorFrames(g, ctx, '#2c2a66');
  papersOutside(g, ctx, time, () => 0);
  drawSign(g, ctx, frame, time, { traced: false, lights: 0.75, chase: true });
  drawBoard(g, ctx, frame, time, false, false);
  pavement(g, ctx, time, 0, wide ? 1 : 0.35);
  lamps(g, ctx, time, 1);
  const boxes: LookBox[] = [];
  boxes.push(...comingSoon(g, ctx, time, null, wide));
  boxes.push(...note(g, ctx, frame, time, 0, true));
  if (!wide) {
    stranger(g, ctx, time);
  }
  g.restore();
  return boxes;
}

/** How long the stranger stands still at the doors before he walks on. */
const STRANGER_STOP = 18;

/**
 * A stranger walks past below; on 48.5 he stops dead, his head snaps up to the
 * doors and a question mark pops over him; he stands still, frowning at the
 * blank paper, then walks on.
 */
function stranger(g: G, ctx: Ctx, time: number): void {
  const from = bf(STRANGER_FROM);
  const stop = bf(STRANGER_LOOK);
  const go = stop + STRANGER_STOP;
  if (time < from) {
    return;
  }
  const walked = time < stop ? time - from : time < go ? stop - from : time - from - STRANGER_STOP;
  const x = 1000 - 17 * walked;
  const t = Math.round(time) - stop;
  // The stop and the look are steps on the hit's own frame, with an overshoot; walking on, they ease back.
  const on = t >= 0 ? 1 + 0.3 * Math.exp(-t / 2.5) * Math.cos(t * 0.9) : 0;
  const leave = clamp(springOf(time, go, SNAPPY));
  const look = on * (1 - leave);
  const planted = t >= 0 ? 1 - smooth(prog(time, go, go + 6)) : 0;
  const face: Face = look > 0.4 ? { eyes: 'wide', mouth: 'wavy', brow: -0.5, look: [0.5, -1], raise: 0.8 } : { eyes: 'dot', mouth: 'flat', brow: 0, look: [-1, 0] };
  const stride = walk(walked * ((2 * Math.PI) / 30));
  const pose: Pose = { ...blend(stride, STAND, planted), head: -0.34 * look, lean: 0.05 * look, squash: t >= 0 && t < 8 ? 0.06 * Math.exp(-t / 2) : 0, face: blinking(face, time, 20) };
  const y = F.ground + 330;
  const s = 240;
  figure(g, ctx, x, y, s, pose, { coat: '#3e8f9a', skin: '#cfc6f2', legs: '#272a5c', face: '#e8e2fb' });
  if (t >= 0 && time < go + 8) {
    const pop = Math.exp(-t / 2.5);
    const out = clamp((time - go) / 8);
    glyph(g, ctx, '?', x + s * 0.32, y - s * 1.78 - 30 * pop, s * 0.55 * (1 + 0.5 * pop) * (1 - 0.6 * out), { face: 'sans', weight: 900, color: '#2a6f7a', rot: 0.2 - 0.25 * pop, alpha: 1 - out });
  }
}

/** COMING SOON painted across both sheets in dark ink; at dawn each half goes with its sheet. */
function comingSoon(g: G, ctx: Ctx, time: number, peel: ((k: number) => number) | null, report: boolean): TextBox[] {
  const at = bf(OUTSIDE);
  const words: readonly (readonly [string, number, number])[] = [
    ['COMING', 1092, 0],
    ['SOON', 1226, 4],
  ];
  const draw = (collect: TextBox['box'][] | null): number => {
    let size = 0;
    for (const [word, y, delay] of words) {
      const t = Math.round(time) - at - delay;
      const s = t < 0 ? 1.15 : 1 + 0.15 * Math.exp(-t / 3) * Math.cos(t * 0.5);
      g.save();
      g.translate(CX, y);
      g.scale(s, s);
      const style = { face: 'sans' as const, weight: 900, size: 124, color: P.inkDark, align: 'center' as const, tracking: 0.04 };
      const box = textLine(g, ctx, word, 0, 0, style, collect !== null ? { id: 'soon', words: 'COMING SOON', role: 'headline' } : null);
      if (box !== null && collect !== null) {
        collect.push(box.box);
        size = box.fontSizePx;
      }
      g.restore();
    }
    return size;
  };
  if (peel !== null) {
    for (let k = 0; k < 2; k++) {
      g.save();
      sheetClip(g, k, peel(k));
      draw(null);
      g.restore();
    }
    return [];
  }
  const collected: TextBox['box'][] = [];
  const size = draw(report ? collected : null);
  return report && collected.length > 0 ? [{ id: 'soon', text: 'COMING SOON', box: unionBox(collected), fontSizePx: size, role: 'headline' }] : [];
}

/** The note: a small white sheet flung on from the left, slapped flat with an overshoot and taped, in a hand's italic. */
function note(g: G, ctx: Ctx, frame: number, time: number, peel: number, copy: boolean): TextBox[] {
  const at = bf(NOTE);
  if (frame < at - 8) {
    return [];
  }
  const fly = inCubic(prog(time, at - 8, at));
  const t = Math.round(time) - at;
  // Big as it arrives, under size on the slap, settling: the overshoot; squashed flat on the slap's own frame.
  const over = t >= 0 && t < 22 ? 0.18 * Math.exp(-t / 4) * Math.cos(t * 0.55) : 0;
  const slap = t >= 0 && t < 12 ? Math.exp(-t / 2.5) : 0;
  const s = lerp(1.6, 1, fly) * (1 + over);
  g.save();
  if (peel > 0) {
    sheetClip(g, 0, peel);
  }
  g.translate(lerp(-160, NOTE_AT.x, fly), lerp(NOTE_AT.y - 220, NOTE_AT.y, fly));
  g.rotate(lerp(-0.7, -0.035, fly));
  g.scale(s * (1 + 0.1 * slap), s * (1 - 0.14 * slap));
  bar(g, ctx, -176, -100, 176, 108, '#fdfbf4');
  if (t >= 0) {
    glyph(g, ctx, '—', -166, -98, 90, { face: 'sans', weight: 800, color: P.amber, alpha: 0.6, rot: -0.7 });
    glyph(g, ctx, '—', 166, -98, 90, { face: 'sans', weight: 800, color: P.amber, alpha: 0.6, rot: 0.7 });
  }
  const style = { face: 'serif' as const, weight: 700, size: 52, color: '#1a1530', italic: true, align: 'center' as const };
  const report = copy && t >= 0 ? { id: 'note', words: 'Not even we can read it.', role: 'support' as const } : null;
  const a = textLine(g, ctx, 'Not even we', 0, -12, style, report);
  const b = textLine(g, ctx, 'can read it.', 0, 56, style, report);
  g.restore();
  if (a === null || b === null || report === null) {
    return [];
  }
  return [{ id: 'note', text: 'Not even we can read it.', box: unionBox([a.box, b.box]), fontSizePx: Math.min(a.fontSizePx, b.fontSizePx), role: 'support' }];
}

/** Beats 50–52: dawn. She peels the paper down from inside, a door a beat, and the lit hall shows through the glass. */
export function dawnShot(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const u = prog(time, bf(50), bf(52));
  const dawn = clamp(0.55 + 0.45 * smooth(u));
  g.save();
  camera(g, camLerp({ x: CX, y: 1130, z: 1 }, { x: CX, y: 1060, z: 1.04 }, smooth(u)));
  dawnSky(g, ctx, time, dawn);
  building(g, ctx, dawn);
  const peel = (k: number): number => prog(time, bf(PEEL_BEATS[k] ?? 50), bf(PEEL_BEATS[k] ?? 50) + 14);
  const lit = clamp(peel(0) + 0.3);
  interior(g, ctx, frame, time, lit);
  const current = PEEL_BEATS.reduce((acc, beat, k) => (frame >= bf(beat) ? k : acc), 0);
  const pull = springOf(time, bf(PEEL_BEATS[current] ?? 50), SNAPPY);
  const reachY = lerp(-1.9, -0.9, clamp(pull));
  figure(g, ctx, current === 0 ? 400 : 680, F.doors.y1 - 30, 180, { ...STAND, handL: [-0.35, reachY], handR: [0.3, reachY + 0.25], head: -0.15, face: { eyes: 'happy', mouth: 'smile', brow: -0.1, look: [0, -0.6] } });
  doorFrames(g, ctx, mix('#2c2a66', '#5a4672', dawn));
  papersOutside(g, ctx, time, peel);
  comingSoon(g, ctx, time, peel, false);
  note(g, ctx, frame, time, peel(0), false);
  drawSign(g, ctx, frame, time, { traced: false, lights: 0.8, chase: true });
  drawBoard(g, ctx, frame, time, false, false);
  pavement(g, ctx, time, dawn);
  lamps(g, ctx, time, 1 - dawn * 0.7);
  g.restore();
  return [];
}

/** The board and the sign held inside the safe area. */
const OPEN_CAM: Cam = { x: CX, y: 860, z: 1.06 };

/** Beats 52–56: she throws O, P, E, N up onto the board, each in view; she cheers; the camera dives into the O. */
export function openShot(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const dive = prog(time, bf(DIVE), bf(56));
  const o = boardSlot(0);
  const m = metric(g, fontOf(ctx, 'sans', 900, 128), 'O');
  const counter = { x: o.x, y: o.y - (m.ascent - m.descent) / 2 };
  let cam: Cam = camLerp({ ...OPEN_CAM, y: 880 }, OPEN_CAM, smooth(prog(time, bf(52), bf(55))));
  if (frame >= bf(DIVE)) {
    // The dive moves on its own frame: a snap in, then an exponential rush into the O's counter.
    const k = 0.12 + 0.88 * inCubic(dive);
    cam = { x: lerp(cam.x, counter.x, smooth(0.3 + dive)), y: lerp(cam.y, counter.y, smooth(0.3 + dive)), z: cam.z * Math.exp(Math.log(70) * k) };
  }
  g.save();
  camera(g, cam);
  dawnSky(g, ctx, time, 1);
  building(g, ctx, 1);
  interior(g, ctx, frame, time, 1);
  doorFrames(g, ctx, '#5a4672');
  drawSign(g, ctx, frame, time, { traced: false, lights: 0.85, chase: true });
  const boxes = drawBoard(g, ctx, frame, time, true, frame >= bf(OPEN_BEATS[3] ?? 54) && frame < bf(DIVE));
  pavement(g, ctx, time, 1);
  lamps(g, ctx, time, 0.3);
  // Each letter leaves her hand twelve frames before it lands, so every throw is seen.
  const throws = OPEN_BEATS.map((b) => bf(b) - 12);
  const thrown = throws.filter((f) => frame >= f).length;
  const flick = env(time, throws, 4);
  const herX = 560;
  const herY = F.ground + 40;
  const s = 200;
  const base: Pose = { ...STAND, handL: [-0.25, -0.62], handR: [0.32 + 0.2 * clamp(flick), -0.75 - 0.9 * clamp(flick)], head: -0.25, face: { eyes: 'wide', mouth: 'smile', brow: 0, look: [0.2, -1], raise: 0.5 } };
  figure(g, ctx, herX, herY, s, frame >= bf(JOY) ? cheer(time, bf(JOY), base) : base);
  for (let k = thrown; k < 4; k++) {
    glyph(g, ctx, 'open'.charAt(k), herX - 30 + (k - thrown) * 26, herY - s * 0.66 - (k - thrown) * 6, 46, { face: 'mono', weight: 800, color: P.amber, rot: hs(k, 131) * 0.4 });
  }
  OPEN_BEATS.forEach((beat, k) => {
    const start = throws[k] ?? 0;
    const land = bf(beat);
    if (frame < start || frame >= land) {
      return;
    }
    const t = (time - start) / (land - start);
    const from = { x: herX + 50, y: herY - s * 1.1 };
    const to = boardSlot(k);
    const x = lerp(from.x, to.x, t);
    const y = lerp(from.y, to.y - 46, t) - Math.sin(Math.PI * t) * 260;
    glyph(g, ctx, t < 0.6 ? 'open'.charAt(k) : 'OPEN'.charAt(k), x, y, lerp(46, 140, outCubic(t)), { face: t < 0.6 ? 'mono' : 'sans', weight: 900, color: mix(P.amber, P.cream, t), rot: (1 - t) * Math.PI * 2 * (k % 2 === 0 ? 1 : -1), sy: 1 + 0.3 * Math.sin(Math.PI * t) });
  });
  g.restore();
  if (dive > 0.7) {
    g.fillStyle = rgba(hex(ctx.brand.background), clamp((dive - 0.7) / 0.3));
    g.fillRect(0, 0, W, H);
  }
  return boxes;
}
