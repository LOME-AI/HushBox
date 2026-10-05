import {
  ANSWER_BEATS,
  ANSWERS,
  BAR_BEATS,
  CODE_LINE_BEATS,
  LAMP_BEATS,
  LAMP_LAG,
  NAME_ASK,
  NAME_FLY,
  OTHERS_FALL,
  PICKED,
  ROW_LETTERS,
  ROWS,
  RUN,
  SCREEN_ON,
  SEARCH_ROW,
  SEATS_LAND,
  SEND,
  SIT,
  SLAB_BEATS,
  SOURCES,
  SOURCE_BEATS,
  TAP,
  TIP,
  WISH,
  WISH_LINES,
  bf,
} from './beats.js';
import { ARMS_UP, LOOK_UP, PHONE, STAND, blend, blinking, figure, walk } from './figure.js';
import { CX, DEFAULT, H, HEAVY, P, PLAYFUL, SNAPPY, W, beatPulse, clamp, env, hash, hs, inCubic, lerp, mix, outBack, outCubic, prog, rgba, smooth, springOf } from './kit.js';
import { lamp, nightSky, project } from './persp.js';
import { composer, composerHeight } from './room.js';
import { camLerp, camera } from './scenes-night.js';
import { glyph, metricAt, textLine } from './type.js';

import type { Face, Pose } from './figure.js';
import type { G } from './kit.js';
import type { Persp } from './persp.js';
import type { ComposerLayout } from './room.js';
import type { Ctx } from './type.js';
import type { LookBox } from '../../../../engine/look/index.js';

/** Where each source chip pops out under the search row: two columns, six rows. */
function chipHome(k: number): { x: number; y: number } {
  return { x: 110 + (k % 2) * 400, y: 820 + Math.floor(k / 2) * 72 };
}

function chip(g: G, ctx: Ctx, text: string, x: number, y: number, size: number, alpha: number, rot = 0, sy = 1, anchor: 'left' | 'center' = 'left'): void {
  glyph(g, ctx, `[ ${text} ]`, x, y, size, { face: 'mono', weight: 600, color: P.cream, alpha, rot, sy, anchor });
}

/** Beats 16–20: the message flies up in plain text; Gemini 3.1 Pro searches the web; twelve sources pop out. */
export function sent(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const t0 = bf(SEND);
  const whip = outCubic(prog(time, t0, t0 + 16));
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0e3346');
  sky.addColorStop(0.55, '#14204f');
  sky.addColorStop(1, '#0a0c24');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  for (let k = 0; k < 60; k++) {
    const y = ((hash(k, 62) * (H + 400) + whip * 1600 + (time - t0) * 1.2) % (H + 400)) - 200;
    const ch = k % 5 === 0 ? '*' : k % 3 === 0 ? '+' : '·';
    glyph(g, ctx, ch, hash(k, 61) * W, y, ch === '·' ? 46 : 26, { face: 'sans', weight: 500, color: P.cream, alpha: 0.45, sy: 1 + 2.5 * (1 - whip) * (time < t0 + 16 ? 1 : 0) });
  }
  const boxes: LookBox[] = [];
  // Her, at the bottom, jumping on the drop and watching it go, the phone still lit in her hand.
  const jump = env(time, [t0], 5);
  const seen = clamp(springOf(time, t0, DEFAULT));
  const watchFace: Face = time < bf(SEARCH_ROW) + 6 ? { eyes: 'wide', mouth: 'o', brow: -0.1, look: [0.6, -1], raise: 0.9 } : { eyes: 'dot', mouth: 'smile', brow: 0.1, look: [0.5, -1], raise: 0.4 };
  const watch: Pose = { ...blend(PHONE, LOOK_UP, seen), handR: [0.42, -0.6], holds: { ch: 'I', color: P.teal, size: 0.34 }, squash: -0.14 * clamp(jump), face: blinking(watchFace, time, 30) };
  figure(g, ctx, 300, 1880, 250, watch);
  // The sent message: the same words, out of the composer and up to the top, readable all the way.
  const fly = outBack(prog(time, t0, t0 + 16), 1.2);
  const size = 60;
  const adv = metricAt(g, ctx, 'mono', 700, false, 'M', size).width;
  const width = Math.max(...WISH_LINES.map((l) => l.length)) * adv + 112;
  const bubble: ComposerLayout = { x: 930 - width, y: lerp(1300, 300, fly), width, size, lines: WISH_LINES };
  const stretch = 0.4 * (1 - clamp(fly)) * (time < t0 + 18 ? 1 : 0);
  const mid = bubble.y + composerHeight(bubble) / 2;
  g.save();
  g.translate(CX, mid);
  g.scale(1 - stretch * 0.3, 1 + stretch);
  g.translate(-CX, -mid);
  boxes.push(...composer(g, ctx, frame, time, bubble, { shown: () => ({ at: null }), cursor: -1, lit: 0, press: 0, bubble: true, report: { id: 'sent-bubble', words: WISH, role: 'imagery' } }));
  g.restore();
  // The answer: its model's name small, then the search row.
  const row = bf(SEARCH_ROW);
  if (frame >= row) {
    const arrive = springOf(time, row, SNAPPY);
    const dx = (1 - arrive) * -80;
    const plate = textLine(g, ctx, 'Gemini 3.1 Pro', 110 + dx * 0.6, 612, { face: 'mono', weight: 600, size: 38, color: P.teal, alpha: clamp(arrive * 1.5) }, { id: 'search-model', words: 'Gemini 3.1 Pro', role: 'imagery' });
    if (plate !== null) {
      boxes.push(plate);
    }
    glyph(g, ctx, '@', 84 + dx, 688, 46, { face: 'sans', weight: 700, color: P.teal, rot: (time - row) * 0.06 });
    // Over the shot's last six frames the row collapses to a line in place, so it leaves with motion as the sources fall.
    const exit = clamp((time - (bf(20) - 6)) / 6);
    g.save();
    g.translate(0, 690);
    g.scale(1 + 0.08 * exit, 1 - 0.85 * exit * exit);
    g.translate(0, -690);
    const search = textLine(g, ctx, 'Searched the web · 12 sources', 124 + dx, 704, { face: 'sans', weight: 650, size: 50, color: P.cream, tracking: 0.1 * Math.exp(-(time - row) / 5) }, { id: 'search', words: 'Searched the web · 12 sources', role: 'support' });
    g.restore();
    if (search !== null) {
      boxes.push(search);
    }
  }
  // The sources pop out on the sixteenths, lift on 19.5 and shiver before they fall.
  const lift = springOf(time, bf(19.5), SNAPPY);
  SOURCES.forEach((text, k) => {
    const at = bf(SOURCE_BEATS[k] ?? 17);
    if (frame < at) {
      return;
    }
    const pop = outBack(prog(time, at, at + 8), 2.2);
    const home = chipHome(k);
    const shiver = lift * 3 * hs(Math.floor(time) * 7 + k, 81);
    // In the shot's last six frames the sources drop out of the bottom of the frame, into the street below.
    const drop = Math.max(0, time - (bf(20) - 6 - (k % 3)));
    chip(g, ctx, text, home.x + shiver, home.y - 16 * lift + 6 * drop * drop, 36 * pop, 1, hs(k, 82) * 0.25 * (1 - clamp(pop)) + 0.02 * drop * hs(k, 83), 1 + 0.06 * drop);
  });
  return boxes;
}

/** The depth of each source's row in the paving, near to far: the path laid ahead of her, towards the shop. */
const PAVE_Z = [3.7, 4.5, 5.4, 6.4, 7.5, 8.8, 10.3, 12, 14, 16.3, 19, 22] as const;
const BUILDINGS = 'HMBENWHE';
const ROAD = 2.3;

/** Beats 20–24: the sources slam down as the street's paving, three rows at a time; lamps rise; she walks up it. */
export function street(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const u = prog(time, bf(20), bf(24));
  const persp: Persp = { f: 900, cx: CX, y0: 690, h: 1.55, z0: lerp(0, 1.3, smooth(u)) };
  nightSky(g, ctx, time, persp.y0, { moonX: 830, moonY: 330 });
  const ground = g.createLinearGradient(0, persp.y0, 0, H);
  ground.addColorStop(0, '#1b1f4a');
  ground.addColorStop(1, '#0b0d24');
  g.fillStyle = ground;
  g.fillRect(0, persp.y0, W, H - persp.y0);
  // The shop at the end of the street: an n, its arch lit.
  const end = project(persp, 0, 0, 27);
  if (end !== null) {
    const glow = g.createRadialGradient(end.x, end.y - end.s * 1.5, 0, end.x, end.y - end.s * 1.5, end.s * 4);
    glow.addColorStop(0, rgba(P.amber, 0.45));
    glow.addColorStop(1, rgba(P.amber, 0));
    g.fillStyle = glow;
    g.fillRect(end.x - end.s * 4, end.y - end.s * 6, end.s * 8, end.s * 8);
    glyph(g, ctx, 'n', end.x, end.y, end.s * 5, { face: 'sans', weight: 900, color: '#4a4795', anchor: 'bottom' });
  }
  // Buildings: big capitals standing back from both kerbs, far to near.
  for (let k = 7; k >= 0; k--) {
    for (const side of [-1, 1]) {
      const z = 5 + k * 3.4 + (side > 0 ? 1.7 : 0);
      const p = project(persp, side * 4.6, 0, z);
      if (p === null) {
        continue;
      }
      const ch = BUILDINGS.charAt((k + (side > 0 ? 3 : 0)) % BUILDINGS.length);
      glyph(g, ctx, ch, p.x, p.y, p.s * 4.2, { face: 'sans', weight: 900, color: mix('#30307a', '#1b1f4a', k / 8), anchor: 'bottom' });
      const lit = 0.5 + 0.5 * Math.sin(time * 0.07 + k * 2 + side);
      glyph(g, ctx, '·', p.x - side * p.s * 0.4, p.y - p.s * 2.2, p.s * 1.1, { face: 'sans', weight: 900, color: P.amber, alpha: 0.6 * lit });
    }
  }
  // The road between the kerbs, and the kerbs: equals signs running to the shop.
  const nearL = project(persp, -ROAD, 0, 2.2);
  const nearR = project(persp, ROAD, 0, 2.2);
  const farL = project(persp, -ROAD, 0, 27);
  const farR = project(persp, ROAD, 0, 27);
  if (nearL !== null && nearR !== null && farL !== null && farR !== null) {
    g.fillStyle = '#0d1030';
    g.beginPath();
    g.moveTo(nearL.x, nearL.y);
    g.lineTo(farL.x, farL.y);
    g.lineTo(farR.x, farR.y);
    g.lineTo(nearR.x, nearR.y);
    g.closePath();
    g.fill();
  }
  for (let z = 2.2; z < 27; z += 0.8) {
    for (const side of [-1, 1]) {
      const p = project(persp, side * (ROAD + 0.1), 0, z);
      if (p !== null) {
        glyph(g, ctx, '=', p.x, p.y, p.s * 0.5, { face: 'mono', weight: 700, color: P.lilac, alpha: clamp(0.75 - z / 40), sy: 0.6 });
      }
    }
  }
  // The paving: each source falls from the sky and slams flat across the road, three rows a beat.
  SOURCES.forEach((text, k) => {
    const z = PAVE_Z[k] ?? 4;
    const land = bf(SLAB_BEATS[Math.floor(k / 3)] ?? 21);
    const fall = 9;
    const t = time - (land - fall);
    if (t < 0) {
      return;
    }
    const y = t < fall ? 5 * (1 - (t / fall) ** 2) : 0;
    const p = project(persp, 0, y, z);
    if (p === null) {
      return;
    }
    const since = time - land;
    const squash = since >= 0 && since < 12 ? Math.exp(-since / 3) : 0;
    const flat = since >= 0 ? clamp((persp.h / (z - persp.z0)) * 2.2) : 1;
    chip(g, ctx, text, p.x, p.y, p.s * 0.34 * (1 + 0.2 * squash), 1, 0, flat * (1 - 0.3 * squash), 'center');
    if (since >= 0 && since < 16) {
      for (let d = 0; d < 6; d++) {
        const side = d < 3 ? -1 : 1;
        const rr = p.s * (0.9 + 1.6 * outCubic(since / 16));
        glyph(g, ctx, '·', p.x + side * rr * (0.8 + 0.25 * (d % 3)), p.y - p.s * 0.1 * (d % 3), p.s * 0.35, { face: 'sans', weight: 900, color: P.lilac, alpha: 0.7 * (1 - since / 16) });
      }
    }
  });
  // The lamps rise near pair first, never as a mirrored pair: one side on the beat, the other a sixteenth
  // later and shorter, the near pair left first and the far pair right first. Each spring starts a
  // frame early, so its tick frame is the first the lamp shoots up on.
  LAMP_BEATS.forEach((beat, pair) => {
    const z = pair === 0 ? 6.6 : 10.5;
    const first = pair === 0 ? -1 : 1;
    for (const side of [-1, 1]) {
      const at = bf(beat + (side === first ? 0 : LAMP_LAG));
      const tall = side === first ? 1 : pair === 0 ? 0.8 : 0.88;
      const grow = springOf(time, at - 1, PLAYFUL);
      const p = project(persp, side * (ROAD + 0.6), 0, z);
      if (p !== null) {
        lamp(g, ctx, p.x, p.y, p.s, clamp(grow, 0, 1.25) * tall, side > 0, clamp((time - at + 1) / 6));
      }
    }
  });
  // She walks up the new street towards the shop, from behind.
  const walkU = prog(time, bf(21.5), bf(24));
  const her = project(persp, lerp(-0.5, -0.15, walkU), 0, lerp(4.4, 7.4, walkU));
  if (her !== null && frame >= bf(21.5)) {
    const phase = (time - bf(21.5)) * ((2 * Math.PI) / 28);
    figure(g, ctx, her.x, her.y, her.s * 1.05, { ...walk(phase), back: true });
  }
  return [];
}

// ---------------------------------------------------------------- code and seats

/** The hall's camera as the chart tips: from facing the upright chart to above and behind the back row. */
function seatPersp(u: number): Persp {
  return { f: 900, cx: CX, y0: lerp(1047, 700, u), h: lerp(2.4, 4.5, u), z0: lerp(0, -1, u) };
}

/** A seat's world place: rows A–H, left-aligned in the chart, centred in the hall; the chart's plane tipped by theta about its base. */
function seatWorld(r: number, i: number, theta: number, centred: number): { x: number; y: number; z: number } {
  const n = ROWS[r] ?? 8;
  const hgt = 7.5 - r;
  const x = lerp(-3.68 + i * 0.75, (i - (n - 1) / 2) * 0.75, centred);
  return { x, y: hgt * Math.cos(theta), z: 12 - hgt * Math.sin(theta) };
}

const CODE = ['rows = [8, 10, 10, 12, 12, 12, 12, 12]', 'for r, n in zip("ABCDEFGH", rows):', '    print(r, "n" * n)'] as const;
const INK = '#1d1934';
const PAPER_BG = '#efe6d0';

/** The colour of each character of a line of Python on paper: keywords teal, numbers amber, strings violet. */
function codeColors(line: string): string[] {
  const colors = [...line].map(() => INK);
  const paint = (re: RegExp, color: string): void => {
    for (const m of line.matchAll(re)) {
      for (let k = 0; k < m[0].length; k++) {
        colors[(m.index ?? 0) + k] = color;
      }
    }
  };
  paint(/\b(for|in|zip|print)\b/g, '#0b7a6e');
  paint(/\d+/g, '#b35a00');
  paint(/"[^"]*"/g, P.violet);
  return colors;
}

/** Draws the chart's seats: rows A–H of n glyphs, each row's letter at its left; `grow` says how much of row r shows. */
function drawSeats(g: G, ctx: Ctx, persp: Persp, thetaOf: number | ((r: number) => number), centred: number, grow: (r: number) => number, lit: number, her: ((r: number) => void) | null, jiggle: (r: number, i: number) => number = () => 0): void {
  for (let r = ROWS.length - 1; r >= 0; r--) {
    const theta = typeof thetaOf === 'number' ? thetaOf : thetaOf(r);
    her?.(r);
    const n = ROWS[r] ?? 8;
    const shown = Math.floor(grow(r) * n + 1e-6);
    const first = seatWorld(r, 0, theta, centred);
    const lp = project(persp, first.x - 0.8, first.y, first.z);
    if (lp !== null && grow(r) > 0) {
      glyph(g, ctx, ROW_LETTERS.charAt(r), lp.x, lp.y, lp.s * 0.42, { face: 'mono', weight: 700, color: mix('#0b7a6e', P.teal, clamp(theta)), anchor: 'bottom' });
    }
    for (let i = 0; i < shown; i++) {
      const w = seatWorld(r, i, theta, centred);
      const p = project(persp, w.x, w.y, w.z);
      if (p === null) {
        continue;
      }
      const fresh = grow(r) < 1 && i === shown - 1 ? 1.3 : 1;
      const squash = jiggle(r, i);
      const sy = lerp(1, 1.15, clamp(theta / (Math.PI / 2))) * (1 - 0.25 * squash);
      glyph(g, ctx, 'n', p.x, p.y, p.s * 0.72 * fresh, { face: 'sans', weight: 800, color: mix(P.violet, P.violetHi, lit * (0.4 + 0.6 * (r / 7))), sx: 1 + 0.3 * Math.max(0, squash), sy, anchor: 'bottom' });
    }
  }
}

/** The run prompt under the code, flaring orange on the run. */
function runLine(g: G, ctx: Ctx, time: number): void {
  const flash = Math.exp(-(time - bf(RUN)) / 5);
  glyph(g, ctx, '>', 104, 580, 44, { face: 'mono', weight: 800, color: '#b35a00', sx: 1 + flash * 0.5, anchor: 'baseline' });
  textLine(g, ctx, 'run', 140, 580, { face: 'mono', weight: 700, size: 38, color: mix('#b35a00', '#ff8a1a', flash) }, null);
}

/** The chart's caption in the panel's ink, springing up into place on the run. */
function caption(g: G, ctx: Ctx, time: number): void {
  const up = springOf(time, bf(RUN), SNAPPY);
  g.save();
  g.translate(CX, 1262 + 50 * (1 - up));
  g.scale(lerp(0.6, 1, up), lerp(0.6, 1, up));
  textLine(g, ctx, 'seats per row', 0, 0, { face: 'mono', weight: 700, size: 32, color: INK, align: 'center' }, null);
  g.restore();
}

/** Beats 24–27: code types on the paper of the document panel; it runs, and a chart of seats per row rises a bar a sixteenth. */
export function code(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const u = prog(time, bf(24), bf(27));
  g.fillStyle = PAPER_BG;
  g.fillRect(0, 0, W, H);
  // Ruled lines of the panel's paper: faint underscores.
  for (let y = 300; y < H; y += 66) {
    for (let x = 30; x < W; x += 60) {
      glyph(g, ctx, '_', x, y, 40, { face: 'mono', weight: 400, color: '#cdbf9f', alpha: 0.5 });
    }
  }
  g.save();
  camera(g, camLerp({ x: CX, y: 900, z: 1 }, { x: CX, y: 920, z: 1.06 }, u));
  const boxes: LookBox[] = [];
  const plate = textLine(g, ctx, 'Claude Sonnet 5.5', 90, 352, { face: 'mono', weight: 700, size: 36, color: '#0b7a6e' }, { id: 'code-model', words: 'Claude Sonnet 5.5', role: 'imagery' });
  if (plate !== null) {
    boxes.push(plate);
  }
  const size = 32;
  const adv = metricAt(g, ctx, 'mono', 600, false, 'M', size).width;
  CODE.forEach((line, k) => {
    const from = bf(k === 0 ? (CODE_LINE_BEATS[0] ?? 24) : (CODE_LINE_BEATS[1] ?? 24.5)) + (k === 2 ? 12 : 0);
    const typed = clamp(Math.floor((frame - from) * 3) + 3, 0, line.length);
    const colors = codeColors(line);
    for (let c = 0; c < typed; c++) {
      const since = time - (from + c / 3);
      const pop = since < 6 ? 0.4 * Math.exp(-since / 2) : 0;
      glyph(g, ctx, line.charAt(c), 100 + (c + 0.5) * adv, 422 + k * 48, size, { face: 'mono', weight: 600, color: colors[c] ?? INK, sy: 1 + pop, anchor: 'baseline' });
    }
  });
  if (frame >= bf(RUN)) {
    runLine(g, ctx, time);
    caption(g, ctx, time);
  }
  g.restore();
  // The chart, on the hall's own projection, so the next shot can tip it.
  drawSeats(g, ctx, seatPersp(0), 0, 0, (r) => {
    const at = bf(BAR_BEATS[r] ?? 25);
    return frame < at ? 0 : clamp(outBack(prog(time, at, at + 6), 1.4));
  }, 0, null);
  return boxes;
}

/** Beats 27–30: the chart tips back into the floor and its bars become the rows; the screen lights; she sits. */
export function seats(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  // Each row tips on its own delay, back rows first, and lands with its own bounce; the last lands on the beat.
  const rowLand = (r: number): number => bf(SEATS_LAND) - (ROWS.length - 1 - r) * 2;
  const thetaOf = (r: number): number => {
    const tip = prog(time, bf(TIP) + (ROWS.length - 1 - r) * 1.5, rowLand(r));
    const land = Math.round(time) - rowLand(r);
    const bounce = land > 0 ? (0.06 + 0.02 * hash(r, 171)) * Math.exp(-land / 5) * Math.sin(land * (0.5 + 0.15 * hash(r, 172))) : 0;
    return (Math.PI / 2) * inCubic(tip) - bounce;
  };
  // On the beat the last row lands and the whole hall slams: every seat squashes flat at once.
  const slam = clamp(env(time, [bf(SEATS_LAND)], 3));
  const jiggle = (r: number, i: number): number => {
    const since = Math.round(time) - rowLand(r) - Math.floor(hash(r * 31 + i, 173) * 4);
    const own = since >= 0 && since < 12 ? Math.exp(-since / 3) * Math.cos(since * 0.9) : 0;
    return own + 1.4 * slam * (0.75 + 0.25 * hash(r * 31 + i, 174));
  };
  const camU = smooth(prog(time, bf(TIP), bf(28.5)));
  const persp = seatPersp(camU);
  const centred = smooth(prog(time, bf(27.25), bf(28.25)));
  // The screen switches on with a flare on its own frame, then warms the hall.
  const screenAt = bf(SCREEN_ON);
  const flare = clamp(env(time, [screenAt], 3));
  const lit = Math.round(time) >= screenAt ? clamp(0.55 + 0.45 * springOf(time, screenAt, HEAVY) + 0.45 * flare) : 0;
  // The panel's paper drains to the dark hall as the chart lies down, and the hall warms as the screen lights.
  const dark = smooth(prog(time, bf(TIP), bf(SEATS_LAND)));
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, mix(PAPER_BG, mix('#0c0f2a', '#251a48', lit), dark));
  bg.addColorStop(1, mix(PAPER_BG, '#07081a', dark));
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // The screen: one wide I, far off, glowing when it lights.
  const sp = project(persp, 0, 3.7, 22);
  if (sp !== null && camU > 0.2) {
    const glow = g.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, sp.s * 14);
    glow.addColorStop(0, rgba(P.amberHot, 0.4 * lit + 0.35 * flare));
    glow.addColorStop(1, rgba(P.amberHot, 0));
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);
    glyph(g, ctx, 'I', sp.x, sp.y, sp.s * 5.2, { face: 'sans', weight: 900, color: mix('#2b2a5a', P.cream, lit), sx: 9, alpha: clamp(camU * 2) });
  }
  // Aisle lights: dots along both sides of the floor.
  for (let z = 4; z < 22; z += 1.4) {
    for (const side of [-1, 1]) {
      const p = project(persp, side * 5.6, 0, z);
      if (p !== null && camU > 0.3) {
        glyph(g, ctx, '·', p.x, p.y, p.s * (0.6 + 0.5 * slam), { face: 'sans', weight: 900, color: P.amber, alpha: clamp(0.6 * camU * (0.6 + 0.4 * beatPulse(time + z * 4, 28, 3)) + 0.4 * slam) });
      }
    }
  }
  const sitAt = bf(SIT);
  // She takes the middle of row A, nearest us, her back to us, so no seat stands between her and the camera.
  const herRow = 0;
  drawSeats(g, ctx, persp, thetaOf, centred, () => 1, lit, (r) => {
    if (r !== herRow || frame < sitAt - 6) {
      return;
    }
    const w = seatWorld(herRow, ((ROWS[herRow] ?? 8) - 1) / 2, thetaOf(herRow), centred);
    const drop = clamp(springOf(time, sitAt - 6, PLAYFUL), 0, 1.2);
    const p = project(persp, w.x + 0.375, w.y + lerp(2.2, 0.32, drop), w.z + 0.25);
    if (p !== null) {
      const squash = env(time, [sitAt], 3);
      figure(g, ctx, p.x, p.y, p.s * 0.95, { ...STAND, hipY: 0.36, back: true, handL: [-0.3, -0.5], handR: [0.32, -0.42], squash: 0.12 * clamp(squash), head: -0.08 + 0.08 * Math.sin(time * 0.05) });
    }
  }, jiggle);
  // The slam's dust: dots thrown off both ends of every row along the floor.
  const dust = Math.round(time) - bf(SEATS_LAND);
  if (dust >= 0 && dust < 16) {
    const out = outCubic(dust / 16);
    for (let r = 0; r < ROWS.length; r++) {
      const n = ROWS[r] ?? 8;
      for (const side of [-1, 1]) {
        const end = seatWorld(r, side < 0 ? 0 : n - 1, Math.PI / 2, centred);
        const p = project(persp, end.x + side * (0.4 + 1.6 * out), 0.3 + 0.8 * out * (1 - out), end.z);
        if (p !== null) {
          glyph(g, ctx, '·', p.x, p.y, p.s * 0.7, { face: 'sans', weight: 900, color: P.lilac, alpha: 0.85 * (1 - dust / 16) });
        }
      }
    }
  }
  // The code and its run prompt leave upward off the paper as the chart tips, and the caption falls
  // flat with the chart, so none of the panel's type vanishes on the cut.
  const away = inCubic(prog(time, bf(TIP), bf(TIP) + 14));
  if (away < 1) {
    g.save();
    camera(g, { x: CX, y: 920, z: 1.06 });
    g.save();
    g.translate(CX, 1262 + 420 * away);
    g.scale(1 + 0.3 * away, 1 - 0.85 * away);
    g.translate(-CX, -1262);
    caption(g, ctx, time);
    g.restore();
    g.translate(0, -700 * away);
    g.scale(1, 1 + 0.6 * away);
    const size = 32;
    const adv = metricAt(g, ctx, 'mono', 600, false, 'M', size).width;
    textLine(g, ctx, 'Claude Sonnet 5.5', 90, 352, { face: 'mono', weight: 700, size: 36, color: '#0b7a6e', alpha: 1 - away }, null);
    CODE.forEach((line, k) => {
      const colors = codeColors(line);
      [...line].forEach((ch, c) => {
        glyph(g, ctx, ch, 100 + (c + 0.5) * adv, 422 + k * 48, size, { face: 'mono', weight: 600, color: colors[c] ?? INK, anchor: 'baseline', alpha: 1 - 0.5 * away });
      });
    });
    runLine(g, ctx, time);
    g.restore();
  }
  return [];
}

// ---------------------------------------------------------------- names

const NAME_TOP = 520;
const NAME_GAP = 168;
const PLATE_INK = '#0b7a6e';
/** Her colours on paper, deepened so she holds against the cream. */
const ON_PAPER = { skin: '#e39a6a', coat: '#d98a12', legs: '#3a3f86' };

/** The stack: her question, then five answers one under another, each with its model's name. */
function nameStack(g: G, ctx: Ctx, frame: number, time: number, picked: number, after: { questionIsCopy: boolean; pickedGone: boolean; away?: number } = { questionIsCopy: true, pickedGone: false }): LookBox[] {
  const away = 1400 * (after.away ?? 0);
  const boxes: LookBox[] = [];
  const ask = bf(NAME_ASK);
  if (frame >= ask) {
    const arrive = springOf(time, ask, SNAPPY);
    const y = 392 + (1 - arrive) * 40 + away;
    const qw = metricAt(g, ctx, 'sans', 700, false, 'what do I call it?', 60).width;
    glyph(g, ctx, '(', 830 - qw - 34, y - 20, 120, { face: 'sans', weight: 200, color: P.violet, alpha: 0.8 });
    glyph(g, ctx, ')', 866, y - 20, 120, { face: 'sans', weight: 200, color: P.violet, alpha: 0.8 });
    const qb = textLine(g, ctx, 'what do I call it?', 830, y, { face: 'sans', weight: 700, size: 60, color: INK, align: 'right' }, { id: 'name-q', words: 'what do I call it?', role: after.questionIsCopy ? 'support' : 'imagery' });
    if (qb !== null) {
      boxes.push(qb);
    }
  }
  const fallAt = bf(OTHERS_FALL);
  // The picked answer is drawn last, so the others fall behind it.
  const order = [...ANSWERS.keys()].filter((k) => k !== PICKED).concat(after.pickedGone ? [] : [PICKED]);
  order.forEach((k) => {
    const answer = ANSWERS[k];
    if (answer === undefined) {
      return;
    }
    const at = bf(ANSWER_BEATS[k] ?? 30.5);
    if (frame < at) {
      return;
    }
    const arrive = springOf(time, at, SNAPPY);
    // The others jolt on the beat and fall, each a frame after the one above it, from a kick so they move on the beat's own frame.
    const order = [...ANSWERS.keys()].filter((j) => j !== PICKED).indexOf(k);
    const fallT = Math.round(time) - fallAt - Math.max(0, order);
    const chosen = k === PICKED && picked > 0;
    let dy = (1 - arrive) * 70 + (k === PICKED ? 0 : away);
    let dx = 0;
    let rot = 0;
    if (picked > 0 && k !== PICKED && fallT >= 0) {
      // Flung out to the left, clear of The Lantern, from a kick that moves them on the beat's own frame.
      dx = -(48 * (fallT + 1) + 4 * fallT * fallT);
      dy += 10 * (fallT + 1) + 1.2 * fallT * fallT;
      rot = -(0.14 + 0.05 * fallT) * (1 + 0.3 * hs(k, 91));
    }
    const y = NAME_TOP + k * NAME_GAP + dy;
    if (y > H + 200) {
      return;
    }
    g.save();
    g.translate(110 + dx, y);
    g.rotate(rot);
    const plate = textLine(g, ctx, answer.model, 0, 0, { face: 'mono', weight: 700, size: 32, color: chosen ? '#b35a00' : PLATE_INK }, { id: `plate-${String(k)}`, words: answer.model, role: 'imagery' });
    const glow = chosen ? clamp(picked) : 0;
    const scale = 1 + 0.14 * glow * Math.exp(-(Math.round(time) - bf(TAP)) / 10);
    g.translate(0, 86);
    g.scale(scale, scale);
    textLine(g, ctx, answer.name, 0, 0, { face: 'sans', weight: 800, size: 80, color: mix(INK, '#c45f00', glow), tracking: 0.25 * Math.exp(-(time - at) / 4) }, null);
    g.restore();
    if (plate !== null) {
      boxes.push(plate);
    }
  });
  return boxes;
}

/** Paper with faint rules, for the chat seen up close. */
function paperGround(g: G, ctx: Ctx, time: number): void {
  g.fillStyle = PAPER_BG;
  g.fillRect(0, 0, W, H);
  for (let k = 0; k < 40; k++) {
    glyph(g, ctx, k % 4 === 0 ? '+' : '·', hash(k, 151) * W, hash(k, 152) * H, k % 4 === 0 ? 30 : 44, { face: 'sans', weight: 500, color: '#c9b993', alpha: 0.4 + 0.3 * Math.sin(time * 0.04 + k) });
  }
}

/** Beats 30–33: she asks for a name; five models answer, one under another on the eighths. */
export function names(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const u = prog(time, bf(30), bf(33));
  paperGround(g, ctx, time);
  g.save();
  camera(g, camLerp({ x: CX, y: 880, z: 1 }, { x: CX, y: 900, z: 1.03 }, u));
  const boxes = nameStack(g, ctx, frame, time, 0);
  g.restore();
  return boxes;
}

/** Beats 33–35: her hand comes up and taps The Lantern; it lights, the other four drop away, and it flies up. */
export function pick(g: G, ctx: Ctx, frame: number, time: number): LookBox[] {
  const tap = bf(TAP);
  const fly = bf(NAME_FLY);
  paperGround(g, ctx, time);
  const push = springOf(time, tap, DEFAULT);
  const pickedY = NAME_TOP + PICKED * NAME_GAP + 86;
  const up = outCubic(prog(time, fly, fly + 20));
  g.save();
  camera(g, camLerp({ x: CX, y: 900, z: 1.03 }, { x: CX, y: pickedY - 60 - 900 * up, z: 1.08 }, clamp(push)));
  // Lit on the tap's own frame: the colour steps, the swell decays from it.
  const picked = frame >= tap ? 1 : 0;
  // The stack stays where it is and leaves the frame below as the camera whips up after the name.
  const boxes = nameStack(g, ctx, frame, time, picked, { questionIsCopy: false, pickedGone: frame >= fly, away: inCubic(prog(time, fly, fly + 18)) });
  if (frame >= fly) {
    // The name leaves the stack and rises, its letters spreading to the sign's tracking.
    const spread = outCubic(prog(time, fly, fly + 24));
    g.save();
    g.translate(110, pickedY - 700 * spread);
    g.scale(1 + 0.6 * spread, 1 + 0.6 * spread);
    textLine(g, ctx, 'The Lantern', 0, 0, { face: 'sans', weight: 800, size: 80, color: '#c45f00', tracking: 0.3 * spread }, null);
    g.restore();
  }
  g.restore();
  // Her, close at the bottom right, the phone at her chest: she lifts it before the beat and taps on it.
  const lift = clamp(springOf(time, tap - 10, SNAPPY)) - clamp(springOf(time, tap, SNAPPY));
  const tapped = clamp(env(time, [tap], 3));
  const herX = 830;
  const herY = 2230;
  const herS = 560;
  const pose: Pose = {
    ...PHONE,
    head: -0.18 - 0.08 * up,
    handR: [PHONE.handR[0] + 0.02, PHONE.handR[1] - 0.12 * lift + 0.05 * tapped],
    handL: [PHONE.handL[0], PHONE.handL[1] - 0.1 * lift],
    squash: 0.04 * tapped,
    holds: { ch: 'I', color: '#0b7a6e', size: 0.34 },
    face: frame >= tap ? { eyes: 'happy', mouth: 'smile', brow: -0.2, look: [-0.6, -1], raise: 0.7 } : blinking({ eyes: 'dot', mouth: 'flat', brow: 0.2, look: [-0.8, -1] }, time, 90),
  };
  figure(g, ctx, herX, herY + 260 * up, herS, pose, ON_PAPER);
  if (tapped > 0.05 && frame < fly) {
    const hand = { x: herX + pose.handR[0] * herS, y: herY + pose.handR[1] * herS };
    const ring = (time - tap) / 14;
    glyph(g, ctx, 'O', hand.x, hand.y, 80 + 420 * ring, { face: 'sans', weight: 200, color: '#c45f00', alpha: clamp(1 - ring) * 0.8 });
  }
  return boxes;
}

void hash;
void HEAVY;
void ARMS_UP;
