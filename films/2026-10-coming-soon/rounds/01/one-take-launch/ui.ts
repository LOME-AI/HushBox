import { Z_FACADE, Z_ROWS, Z_SCREEN, onLayer, onScreen, proj, scaleAt, uiLift, visible } from './camera.js';
import { DEFAULT, H, HEAVY, PLAYFUL, SNAPPY, TAU, W, bf, clamp, hash, hs, lerp, lerpBox, mix, prog, rgba, roundRect, spring } from './kit.js';
import { BEAT, NAMES, PICKED, Q1, Q2, RAIN, TYPE_FRAMES } from './score.js';
import { drawText, fontOf, measure } from './type.js';
import { CHART_VALUES, CHIP_HUES, NAME_PANEL, SCREEN, SIGN, SLAB_ORDER, drawSignArt, nightness, rowBox, slab } from './world.js';
import { POPS, popFrame } from './letters.js';

import type { Cam } from './camera.js';
import type { Box, G } from './kit.js';
import type { LineLayout } from './letters.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

// ---------------------------------------------------------------- brand colours

const HEX = new Map<string, string>();
/** A brand colour as `#rrggbb`, whatever CSS colour syntax the stylesheet used. */
export function hex(css: string): string {
  const cached = HEX.get(css);
  if (cached !== undefined) {
    return cached;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (g === null) {
    throw new Error('one-take-launch: no 2D context to resolve a brand colour');
  }
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gg = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
  const out = `#${((r << 16) | (gg << 8) | b).toString(16).padStart(6, '0')}`;
  HEX.set(css, out);
  return out;
}

export interface Ui {
  bg: string;
  card: string;
  line: string;
  text: string;
  muted: string;
  red: string;
}

export function uiColors(ctx: Ctx): Ui {
  const bg = hex(ctx.brand.background);
  const text = hex(ctx.brand.foreground);
  return { bg, card: mix(bg, text, 0.07), line: mix(bg, text, 0.2), text, muted: hex(ctx.brand.muted), red: hex(ctx.brand.brandRed) };
}

function card(g: G, ui: Ui, b: Box, r = 34): void {
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 40;
  g.shadowOffsetY = 14;
  g.fillStyle = ui.card;
  roundRect(g, b.x, b.y, b.w, b.h, r);
  g.fill();
  g.restore();
  g.strokeStyle = ui.line;
  g.lineWidth = 2;
  roundRect(g, b.x, b.y, b.w, b.h, r);
  g.stroke();
}

/** Scales `g` about a point; the caller saves and restores. */
function about(g: G, x: number, y: number, sx: number, sy = sx): void {
  g.translate(x, y);
  g.scale(sx, sy);
  g.translate(-x, -y);
}

// ---------------------------------------------------------------- the composer

const PILL: Box = { x: 70, y: 830, w: 940, h: 132 };
const TEXT_X = 118;
const TEXT_BASE = 918;
const TEXT_PX = 60;
const SEND = { x: 940, y: 896, r: 46 };

/** How many characters of a line are typed at a frame. */
function typed(frame: number, from: number, length: number): number {
  return clamp(Math.floor((frame - from) / TYPE_FRAMES) + 1, 0, length);
}

/** The line in the composer at a frame: what is typed of the first question, what deletion has left, or the second. */
function composerLine(frame: number): { text: string; full: string; typing: boolean } {
  if (frame < bf(BEAT.pops[0])) {
    const n = frame < bf(BEAT.type) ? 0 : typed(frame, bf(BEAT.type), Q1.length);
    return { text: Q1.slice(0, n), full: Q1, typing: n > 0 && n < Q1.length };
  }
  if (frame < bf(BEAT.ask)) {
    // Each group leaves on its pop; what is left ends before the earliest group gone.
    let end = Q1.length;
    POPS.forEach(({ start }, group) => {
      if (frame >= popFrame(group)) {
        end = Math.min(end, Math.max(0, start - 1));
      }
    });
    return { text: Q1.slice(0, end), full: Q1, typing: false };
  }
  const n = typed(frame, bf(BEAT.ask), Q2.length);
  return { text: frame < bf(BEAT.send) ? Q2.slice(0, n) : '', full: Q2, typing: n > 0 && n < Q2.length };
}

/** Where each character of the lines that fall from the composer sat, for the letters that fall from it. */
export function composerLayout(g: G, ctx: Ctx, cam: Cam): LineLayout {
  const widths = (text: string): number[] => Array.from({ length: text.length + 1 }, (_, i) => measure(g, ctx, text.slice(0, i), 'sans', 500, TEXT_PX));
  const q1 = widths(Q1);
  const rain = widths(RAIN);
  return {
    x: (line, index) => {
      const w = line === 'q1' ? q1 : rain;
      return TEXT_X + ((w[index] ?? 0) + (w[index + 1] ?? 0)) / 2;
    },
    y: TEXT_BASE - TEXT_PX * 0.36 - uiLift(cam),
    size: TEXT_PX,
  };
}

/** The touch point: a soft disc that reaches for Send and pulls back, then presses it. */
function drawTouch(g: G, time: number, lift: number): void {
  const appear = spring(time, bf(BEAT.hover) - 12, SNAPPY) - spring(time, bf(BEAT.withdraw) + 6, SNAPPY) + spring(time, bf(BEAT.send) - 14, SNAPPY) - spring(time, bf(BEAT.send) + 8, SNAPPY);
  if (appear <= 0.01) {
    return;
  }
  const reach = spring(time, bf(BEAT.hover) - 12, DEFAULT) - spring(time, bf(BEAT.withdraw) - 5, SNAPPY) + spring(time, bf(BEAT.send) - 14, SNAPPY);
  const x = lerp(890, SEND.x, clamp(reach));
  const y = lerp(1180, SEND.y, clamp(reach)) - lift;
  const press = clamp(spring(time, bf(BEAT.send) - 2, SNAPPY) - spring(time, bf(BEAT.send) + 3, SNAPPY));
  const r = 40 * clamp(appear, 0, 1.1) * (1 - 0.18 * press);
  g.fillStyle = 'rgba(255,255,255,0.22)';
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
  g.stroke();
}

/**
 * The composer: the first question typing, held, deleted word by word; the
 * second typing and sent. Returns the copy boxes it drew.
 */
export function drawComposer(g: G, ctx: Ctx, cam: Cam, frame: number, time: number): TextBox[] {
  const ui = uiColors(ctx);
  const boxes: TextBox[] = [];
  const away = spring(time, bf(BEAT.send) + 15, HEAVY);
  if (away > 1.2) {
    return boxes;
  }
  onScreen(g, null);
  g.save();
  g.translate(0, 1300 * away - uiLift(cam));
  const line = composerLine(frame);
  card(g, ui, PILL, PILL.h / 2);
  // The cursor blinks on the half beats while idle.
  const n = line.text.length;
  const w = measure(g, ctx, line.text, 'sans', 500, TEXT_PX);
  const idle = !line.typing && Math.floor(frame / 15) % 2 === 0;
  if ((line.typing || idle) && frame < bf(BEAT.send)) {
    g.fillStyle = ui.text;
    g.fillRect(TEXT_X + w + 6, TEXT_BASE - 46, 4, 58);
  }
  if (n === 0 && frame < bf(BEAT.ask)) {
    // The empty composer's placeholder, as the app writes it.
    boxes.push(drawText(g, ctx, { id: 'placeholder', text: 'Type a message...', x: TEXT_X + 18, y: TEXT_BASE, size: TEXT_PX, face: 'sans', weight: 500, fill: mix(ui.card, ui.muted, 0.6), role: 'imagery' }));
  }
  if (n > 0) {
    const id = frame < bf(BEAT.pops[0]) ? 'q1' : frame < bf(BEAT.ask) ? 'q1-left' : 'q2';
    const role = id === 'q1-left' ? 'imagery' : 'support';
    const drawn = drawText(g, ctx, { id, text: line.text, x: TEXT_X, y: TEXT_BASE, size: TEXT_PX, face: 'sans', weight: 500, fill: ui.text, role });
    // The box is what is typed so far; a copy row names its whole line.
    boxes.push(role === 'support' ? { ...drawn, text: line.full } : drawn);
  }
  // Send: red while there is a line to send, grey when empty; it squashes on the press.
  const press = clamp(spring(time, bf(BEAT.send) - 2, SNAPPY) - spring(time, bf(BEAT.send) + 4, DEFAULT));
  const hover = spring(time, bf(BEAT.hover), SNAPPY) - spring(time, bf(BEAT.withdraw), SNAPPY);
  g.save();
  about(g, SEND.x, SEND.y, 1 + 0.08 * hover - 0.16 * press);
  g.fillStyle = n > 0 ? ui.red : mix(ui.card, ui.text, 0.18);
  g.beginPath();
  g.arc(SEND.x, SEND.y, SEND.r, 0, TAU);
  g.fill();
  g.strokeStyle = n > 0 ? '#ffffff' : mix(ui.card, ui.text, 0.45);
  g.lineWidth = 6;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(SEND.x, SEND.y + 18);
  g.lineTo(SEND.x, SEND.y - 18);
  g.moveTo(SEND.x - 14, SEND.y - 4);
  g.lineTo(SEND.x, SEND.y - 18);
  g.lineTo(SEND.x + 14, SEND.y - 4);
  g.stroke();
  g.restore();
  g.restore();
  drawTouch(g, time, uiLift(cam));
  return boxes;
}

// ---------------------------------------------------------------- the sent bubble

function bubbleBox(g: G, ctx: Ctx): Box {
  const tw = measure(g, ctx, Q2, 'sans', 500, TEXT_PX);
  return { x: 880 - tw - 40, y: 318, w: tw + 80, h: 108 };
}

/** On Send the line lifts out of the composer into a bubble that rises to the top, and scrolls away when the search arrives. */
export function drawBubble(g: G, ctx: Ctx, frame: number, time: number): TextBox[] {
  if (frame < bf(BEAT.send)) {
    return [];
  }
  const ui = uiColors(ctx);
  onScreen(g, null);
  const rise = spring(time, bf(BEAT.send), DEFAULT);
  const scroll = spring(time, bf(BEAT.stand), DEFAULT);
  const end = bubbleBox(g, ctx);
  const tw = end.w - 80;
  const start: Box = { x: TEXT_X - 40, y: PILL.y, w: tw + 80, h: PILL.h };
  const b = lerpBox(start, end, rise);
  b.y -= 520 * scroll;
  if (b.y + b.h < -40) {
    return [];
  }
  g.fillStyle = mix(ui.card, mix(ui.card, ui.text, 0.12), clamp(rise));
  roundRect(g, b.x, b.y, b.w, b.h, 40);
  g.fill();
  const id = frame < bf(BEAT.reply) ? 'q2' : 'q2-bubble';
  return [drawText(g, ctx, { id, text: Q2, x: b.x + 40, y: b.y + b.h / 2 + 20, size: TEXT_PX, face: 'sans', weight: 500, fill: ui.text, role: id === 'q2' ? 'support' : 'imagery' })];
}

// ---------------------------------------------------------------- the document card: chart, then screen and seats

const DOC: Box = { x: 90, y: 420, w: 900, h: 480 };
const BAR_X = 150;
const BAR_W = 640;
function barBox(b: number, grow: number): Box {
  const v = CHART_VALUES[b] ?? 10;
  return { x: BAR_X, y: 650 + b * 56, w: (BAR_W * v * grow) / 14, h: 40 };
}

/** The frame the card lands on the back wall as the screen. */
export const SCREEN_LAND = bf(BEAT.rows[0]);

/** The doc card's flight to the back wall: 0 still a card, 1 landed as the screen. */
function cardFlight(time: number): number {
  // It leaves fast, already moving on its cue, and eases onto the wall.
  const u = prog(time, bf(BEAT.seatsMorph) - 4, SCREEN_LAND);
  return 1 - (1 - u) ** 3;
}

/** Whether the document or its bars are on screen: from just before the reply until the last row lands. */
export function docActive(time: number): boolean {
  return time >= bf(BEAT.reply) - 6 && time < bf(BEAT.rows[3]);
}

/** The frame bar b leaves for its row, and the frame it lands as that row. */
function barLaunch(b: number): number {
  return bf(BEAT.rows[b] ?? 16.5) - 15;
}
export function rowLand(r: number): number {
  return bf(BEAT.rows[3 - r] ?? 16.5);
}

function projectedBox(cam: Cam, box: Box, z: number): Box {
  const [x0, y0] = proj(cam, box.x, box.y, z);
  const [x1, y1] = proj(cam, box.x + box.w, box.y + box.h, z);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The reply as a document: it springs in and overshoots; its code holds; Run
 * is pressed; the code folds and the chart draws a bar a half beat. Then the
 * card flies to the back wall and lands as the screen, and the bars, left
 * hanging, drop one per half beat into the hall, deepest first, each landing
 * as a row of seats.
 */
export function drawDocCard(g: G, ctx: Ctx, cam: Cam, time: number): TextBox[] {
  const boxes: TextBox[] = [];
  if (!docActive(time)) {
    return boxes;
  }
  const ui = uiColors(ctx);
  const m = cardFlight(time);
  onScreen(g, null);
  const arrive = spring(time, bf(BEAT.reply) - 6, PLAYFUL);
  if (time < SCREEN_LAND) {
    const screen = visible(cam, Z_SCREEN) ? projectedBox(cam, SCREEN, Z_SCREEN) : DOC;
    const box = lerpBox(DOC, screen, m);
    g.save();
    about(g, box.x + box.w / 2, box.y + box.h / 2, 0.55 + 0.45 * arrive);
    g.translate(0, 160 * (1 - arrive));
    g.fillStyle = ui.card;
    roundRect(g, box.x, box.y, box.w, box.h, lerp(34, 6, m));
    g.fill();
    g.strokeStyle = ui.line;
    g.lineWidth = 2;
    roundRect(g, box.x, box.y, box.w, box.h, lerp(34, 6, m));
    g.stroke();
    // The card's contents shrink away into the screen as it flies.
    const inner = clamp(1 - m / 0.6);
    if (inner > 0) {
      g.save();
      g.translate(box.x, box.y);
      g.scale((box.w / DOC.w) * inner, (box.h / DOC.h) * inner);
      g.translate(-DOC.x, -DOC.y);
      boxes.push(drawText(g, ctx, { id: 'np-doc', text: 'GPT-5.5', x: 130, y: 482, size: 30, face: 'sans', weight: 600, fill: ui.muted, role: 'imagery' }));
      // Run is down on its frame and springs back up.
      const run = time >= bf(BEAT.run) ? 1 - clamp(spring(time, bf(BEAT.run) + 3, DEFAULT)) : 0;
      g.save();
      about(g, 895, 474, 1 - 0.14 * run);
      g.fillStyle = mix(ui.card, ui.text, 0.12 + 0.35 * run);
      roundRect(g, 830, 450, 130, 48, 24);
      g.fill();
      g.restore();
      boxes.push(drawText(g, ctx, { id: 'run', text: '▶ Run', x: 895, y: 484, size: 26, face: 'sans', weight: 700, fill: ui.text, role: 'imagery', align: 'center' }));
      const code = clamp(1 - spring(time, bf(BEAT.bars[0]) - 8, SNAPPY));
      if (code > 0.02) {
        g.save();
        about(g, DOC.x + DOC.w / 2, 560, 1, code);
        boxes.push(drawText(g, ctx, { id: 'code-1', text: 'seats = [11, 12, 13, 14]', x: 130, y: 556, size: 32, face: 'mono', weight: 500, fill: ui.text, role: 'imagery' }));
        boxes.push(drawText(g, ctx, { id: 'code-2', text: 'plt.barh(range(4), seats)', x: 130, y: 604, size: 32, face: 'mono', weight: 500, fill: ui.muted, role: 'imagery' }));
        g.restore();
      }
      if (code < 0.5) {
        boxes.push(drawText(g, ctx, { id: 'chart-title', text: 'seats per row', x: 130, y: 600 + 40 * code, size: 28, face: 'sans', weight: 600, fill: ui.muted, role: 'imagery' }));
      }
      g.restore();
    }
    g.restore();
  }
  // The bars: each grows on its half beat, hangs once the card has gone, then drops to its row.
  onScreen(g, null);
  CHART_VALUES.forEach((v, b) => {
    const grow = spring(time, bf(BEAT.bars[b] ?? 14) - 4, SNAPPY);
    const launch = barLaunch(b);
    const land = launch + 15;
    if (grow <= 0 || time >= land) {
      return;
    }
    const at = barBox(b, Math.max(0, grow));
    const k = 0.55 + 0.45 * arrive;
    const cx = DOC.x + DOC.w / 2;
    const cy = DOC.y + DOC.h / 2;
    const from: Box = { x: cx + (at.x - cx) * k, y: cy + (at.y - cy) * k + 160 * (1 - arrive), w: at.w * k, h: at.h * k };
    const r = 3 - b;
    const z = Z_ROWS[r] ?? 1300;
    const to = visible(cam, z) ? projectedBox(cam, rowBox(r), z) : from;
    // It drops faster and faster, so it lands with weight on its frame.
    const u = time < launch ? 0 : (time - launch) / (land - launch);
    const mb = u * u;
    const bx = lerpBox(from, to, mb);
    bx.y -= 60 * Math.sin(Math.PI * Math.min(1, u * 1.4)) * (1 - u);
    g.fillStyle = mix('#5560a0', '#3e4680', mb);
    roundRect(g, bx.x, bx.y, Math.max(1, bx.w), bx.h, lerp(10, 6, mb));
    g.fill();
    if (u === 0 && time < SCREEN_LAND) {
      boxes.push(drawText(g, ctx, { id: `bar-${String(b)}`, text: String(v), x: bx.x + bx.w + 14, y: bx.y + 30, size: 28, face: 'sans', weight: 700, fill: ui.muted, role: 'imagery' }));
    }
  });
  return boxes;
}

// ---------------------------------------------------------------- the search: chips become the paving

const SEARCH: Box = { x: 90, y: 300, w: 900, h: 296 };
const CHIP = 56;
const CHIP_GLYPHS = ['N', 'W', 'C', 'L', 'R', 'F', 'B', 'T', 'M', 'S', 'A', 'D'] as const;
function chipBox(j: number): Box {
  return { x: 130 + j * 68, y: 488, w: CHIP, h: CHIP };
}
function chipLaunch(j: number): number {
  return bf((BEAT.chips[Math.floor(j / 4)] ?? 20.5) - 0.5) - (j % 4) * 2;
}
export function chipLand(j: number): number {
  return bf(BEAT.chips[Math.floor(j / 4)] ?? 20.5);
}
/** The frame slab i was laid, or −1 before it. */
export function slabLaidAt(i: number, time: number): number {
  const j = SLAB_ORDER.indexOf(i as (typeof SLAB_ORDER)[number]);
  const land = chipLand(j);
  return time >= land ? land : -1;
}

function searchCollapse(time: number): number {
  return clamp(spring(time, bf(BEAT.road) - 6, SNAPPY));
}

export function drawSearchCard(g: G, ctx: Ctx, cam: Cam, time: number): TextBox[] {
  const boxes: TextBox[] = [];
  if (time < bf(BEAT.search) - 6) {
    return boxes;
  }
  const ui = uiColors(ctx);
  const arrive = spring(time, bf(BEAT.search) - 6, PLAYFUL);
  const collapse = searchCollapse(time);
  onScreen(g, null);
  if (collapse < 0.995) {
    g.save();
    about(g, SEARCH.x + SEARCH.w / 2, SEARCH.y + SEARCH.h / 2, (0.6 + 0.4 * arrive) * (1 - 0.1 * collapse), (0.6 + 0.4 * arrive) * (1 - collapse));
    g.translate(0, 240 * (1 - arrive));
    card(g, ui, SEARCH);
    boxes.push(drawText(g, ctx, { id: 'np-search', text: 'Gemini 3.1 Pro', x: 130, y: 356, size: 30, face: 'sans', weight: 600, fill: ui.muted, role: 'imagery' }));
    // A magnifier, then the row.
    g.strokeStyle = ui.text;
    g.lineWidth = 4;
    g.beginPath();
    g.arc(145, 419, 12, 0, TAU);
    g.moveTo(154, 428);
    g.lineTo(164, 438);
    g.stroke();
    boxes.push(drawText(g, ctx, { id: 'searched', text: 'Searched the web · 12 sources', x: 180, y: 434, size: 36, face: 'sans', weight: 600, fill: ui.text, role: 'imagery' }));
    g.restore();
  }
  // The chips: three leave on each half beat, fall, and lay as slabs.
  for (let j = 0; j < 12; j++) {
    const launch = chipLaunch(j);
    const land = chipLand(j);
    if (time >= land) {
      continue;
    }
    const cb = chipBox(j);
    const yIn = 240 * (1 - arrive);
    const i = SLAB_ORDER[j] ?? 0;
    const hue = CHIP_HUES[i] ?? '#666666';
    // Each chip falls faster and faster and slams down as its slab on the frame.
    const raw = time < launch ? 0 : (time - launch) / (land - launch);
    const u = raw * raw;
    const pop = time < launch ? spring(time, bf(BEAT.search) - 2 + j, PLAYFUL) : 1;
    const s = slab(i);
    const ok = visible(cam, s.z1 + 3);
    const corners: [number, number][] = ok
      ? [proj(cam, s.x0 + 4, 1500, s.z0 - 3), proj(cam, s.x1 - 4, 1500, s.z0 - 3), proj(cam, s.x1 - 4, 1500, s.z1 + 3), proj(cam, s.x0 + 4, 1500, s.z1 + 3)]
      : [[cb.x, cb.y], [cb.x + cb.w, cb.y], [cb.x + cb.w, cb.y + cb.h], [cb.x, cb.y + cb.h]];
    const from: [number, number][] = [[cb.x, cb.y + yIn], [cb.x + cb.w, cb.y + yIn], [cb.x + cb.w, cb.y + cb.h + yIn], [cb.x, cb.y + cb.h + yIn]];
    const lift = -120 * Math.sin(Math.PI * raw) * (1 - raw) * (0.6 + 0.4 * hash(j, 61));
    const pts = from.map(([fx, fy], c) => {
      const [tx, ty] = corners[c] as [number, number];
      return [lerp(fx, tx, u), lerp(fy, ty, u) + lift] as const;
    });
    const cx = pts.reduce((a, p) => a + p[0], 0) / 4;
    const cy = pts.reduce((a, p) => a + p[1], 0) / 4;
    g.save();
    about(g, cx, cy, clamp(pop, 0, 1.2));
    g.translate(cx, cy);
    g.rotate(hs(j, 62) * 0.6 * Math.sin(Math.PI * u));
    g.translate(-cx, -cy);
    g.fillStyle = mix(hue, mix('#5a5870', hue, 0.35), u);
    g.beginPath();
    pts.forEach(([px, py], c) => (c === 0 ? g.moveTo(px, py) : g.lineTo(px, py)));
    g.closePath();
    g.fill();
    if (u < 0.5) {
      g.save();
      about(g, cx, cy, 1 - u * 2);
      boxes.push(drawText(g, ctx, { id: `chip-${String(j)}`, text: CHIP_GLYPHS[j] ?? 'A', x: cx, y: cy + 11, size: 30, face: 'sans', weight: 800, fill: '#ffffff', role: 'imagery', align: 'center' }));
      g.restore();
    }
    g.restore();
  }
  return boxes;
}

// ---------------------------------------------------------------- the image: the model draws the sign

const IMAGE: Box = { x: 170, y: 1030, w: 740, h: 512 };
const TILE: Box = { x: 196, y: 1104, w: 688, h: 412 };
/** The part of the facade the image shows: the sign and the board, on the wall. */
export const ART: Box = { x: 140, y: 270, w: 800, h: 512 };

let artCanvas: CanvasRenderingContext2D | null = null;
let smallCanvas: CanvasRenderingContext2D | null = null;
function offscreen(w: number, h: number, which: 'art' | 'small'): CanvasRenderingContext2D {
  const current = which === 'art' ? artCanvas : smallCanvas;
  if (current !== null && current.canvas.width === w && current.canvas.height === h) {
    current.reset();
    return current;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    throw new Error('one-take-launch: no offscreen 2D context');
  }
  if (which === 'art') {
    artCanvas = context;
  } else {
    smallCanvas = context;
  }
  return context;
}

/** The image the model draws: the wall, the marquee and the board, as the facade will hold them. */
function paintArt(time: number, wall: string): CanvasRenderingContext2D {
  const scale = 1;
  const w = Math.round(ART.w * scale);
  const h = Math.round(ART.h * scale);
  const a = offscreen(w, h, 'art');
  a.scale(scale, scale);
  a.translate(-ART.x, -ART.y);
  a.fillStyle = wall;
  a.fillRect(ART.x, ART.y, ART.w, ART.h);
  a.fillStyle = rgba('#000000', 0.07);
  for (let y = 250 + 70; y < ART.y + ART.h; y += 64) {
    a.fillRect(ART.x, y, ART.w, 3);
  }
  drawSignArt(a, { bulbs: 1, chase: 0, name: 0, day: 1 - nightness(time) });
  return a;
}

/** The block size of the image as it resolves: coarse on the image beat, finer on each denoise beat. */
function blockAt(time: number): number {
  const steps = [bf(BEAT.image), ...BEAT.denoise.map(bf), bf(BEAT.denoise[1]) + 8];
  const sizes = [40, 16, 6, 1];
  let size = sizes[0] ?? 1;
  steps.forEach((f, i) => {
    if (time >= f) {
      size = sizes[i] ?? 1;
    }
  });
  return size;
}

/** The image's lift onto the facade: it leaves gently and slams into place, still accelerating. */
export function imageLift(time: number): number {
  const u = prog(time, bf(BEAT.lift) - 3, bf(BEAT.sign));
  return u * u;
}

export function drawImageCard(g: G, ctx: Ctx, cam: Cam, time: number, wall: string): TextBox[] {
  const boxes: TextBox[] = [];
  if (time < bf(BEAT.image) - 6 || time >= bf(BEAT.sign)) {
    return boxes;
  }
  const ui = uiColors(ctx);
  const arrive = spring(time, bf(BEAT.image) - 6, PLAYFUL);
  const lift = imageLift(time);
  onScreen(g, null);
  // The card chrome shrinks into the tile as it lifts.
  const chrome = clamp(1 - lift * 2.5);
  if (chrome > 0) {
    g.save();
    about(g, IMAGE.x + IMAGE.w / 2, IMAGE.y + IMAGE.h / 2, (0.7 + 0.3 * arrive) * (0.9 + 0.1 * chrome));
    g.translate(0, 240 * (1 - arrive));
    const shrunk = lerpBox(TILE, IMAGE, chrome);
    card(g, ui, shrunk);
    if (chrome > 0.6) {
      boxes.push(drawText(g, ctx, { id: 'np-image', text: 'Seedream 5.0', x: 204, y: 1080, size: 30, face: 'sans', weight: 600, fill: ui.muted, role: 'imagery' }));
    }
    g.restore();
  }
  // The tile, fitted to the art, flies onto the facade.
  const fitW = TILE.h * (ART.w / ART.h);
  const tile: Box = { x: TILE.x + (TILE.w - fitW) / 2, y: TILE.y + 240 * (1 - arrive), w: fitW, h: TILE.h };
  const target = visible(cam, Z_FACADE) ? projectedBox(cam, ART, Z_FACADE) : tile;
  const box = lerpBox(tile, target, lift);
  box.y -= 60 * Math.sin(Math.PI * lift);
  const art = paintArt(time, wall);
  const block = lift > 0 ? 1 : blockAt(time);
  g.save();
  roundRect(g, box.x, box.y, box.w, box.h, lerp(18, 0, lift));
  g.clip();
  if (block > 1) {
    const sw = Math.max(2, Math.round(box.w / block));
    const sh = Math.max(2, Math.round(box.h / block));
    const small = offscreen(sw, sh, 'small');
    small.imageSmoothingEnabled = true;
    small.drawImage(art.canvas, 0, 0, sw, sh);
    // A little seeded noise on each block, less at each step, as a diffusion image resolves.
    const amp = block / 40;
    for (let yy = 0; yy < sh; yy++) {
      for (let xx = 0; xx < sw; xx++) {
        const n = hs(xx * 977 + yy * 131 + block, 71);
        small.fillStyle = n > 0 ? rgba('#ffffff', n * 0.25 * amp) : rgba('#000000', -n * 0.35 * amp);
        small.fillRect(xx, yy, 1, 1);
      }
    }
    g.imageSmoothingEnabled = false;
    g.drawImage(small.canvas, box.x, box.y, box.w, box.h);
    g.imageSmoothingEnabled = true;
  } else {
    g.drawImage(art.canvas, box.x, box.y, box.w, box.h);
  }
  g.restore();
  return boxes;
}

// ---------------------------------------------------------------- the names: four models, one pick

function nameCard(i: number): Box {
  return { x: 120, y: 300 + i * 152, w: 840, h: 132 };
}
const NAME_TEXT_PX = 50;
/** The sign's lettering, in facade units. */
export const SIGN_NAME_PX = 66;

function nameLaunch(c: number): number {
  return bf(BEAT.nameFly) - 4 + Math.round(c * 0.8);
}
export function nameLand(c: number): number {
  return nameLaunch(c) + 18;
}

/** Where each letter of the picked name sits on the sign, in facade units: its centre. */
export function signLetters(g: G, ctx: Ctx): { ch: string; x: number; y: number }[] {
  const name = NAMES[PICKED].name;
  const total = measure(g, ctx, name, 'serif', 900, SIGN_NAME_PX, 0.02);
  const left = SIGN.x + SIGN.w / 2 - total / 2;
  return [...name].map((ch, i) => {
    const a = measure(g, ctx, name.slice(0, i), 'serif', 900, SIGN_NAME_PX, 0.02);
    const b = measure(g, ctx, name.slice(0, i + 1), 'serif', 900, SIGN_NAME_PX, 0.02);
    return { ch, x: left + (a + b) / 2, y: NAME_PANEL.y + NAME_PANEL.h / 2 + SIGN_NAME_PX * 0.34 };
  });
}

/** The picked name's letters once they are on the sign; lit from the lit beat. */
export function drawSignName(g: G, ctx: Ctx, cam: Cam, time: number): TextBox[] {
  if (!visible(cam, Z_FACADE) || time < nameLand(0)) {
    return [];
  }
  const letters = signLetters(g, ctx);
  const s = onLayer(g, cam, Z_FACADE);
  void s;
  const lit = clamp(spring(time, bf(BEAT.lit), SNAPPY));
  const day = 1 - nightness(time);
  g.save();
  g.font = fontOf(ctx, 'serif', 900, SIGN_NAME_PX);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  letters.forEach(({ ch, x, y }, c) => {
    const land = nameLand(c);
    if (time < land) {
      return;
    }
    const pop = 1 - clamp(spring(time, land, SNAPPY));
    g.save();
    g.translate(x, y);
    g.scale(1 + 0.2 * pop, 1 - 0.1 * pop);
    if (lit > 0) {
      g.shadowColor = rgba('#ffd27a', 0.9 * lit * (1 - 0.5 * day));
      g.shadowBlur = 30 * lit;
    }
    g.fillStyle = mix('#cbbfa8', '#fff4d4', lit);
    g.fillText(ch, 0, 0);
    g.restore();
  });
  g.restore();
  return [];
}

export function drawNameCards(g: G, ctx: Ctx, cam: Cam, time: number): TextBox[] {
  const boxes: TextBox[] = [];
  if (time < bf(BEAT.names[0]) - 6 || time >= bf(BEAT.lit) + 30) {
    return boxes;
  }
  const ui = uiColors(ctx);
  onScreen(g, null);
  const pick = spring(time, bf(BEAT.pick), SNAPPY);
  NAMES.forEach(({ model, name }, i) => {
    // Each card slides in faster and faster and lands on its frame, then settles with an overshoot.
    const at = bf(BEAT.names[i] ?? 26.5);
    if (time < at - 9) {
      return;
    }
    const slide = clamp((time - (at - 9)) / 9);
    const settle = time < at ? 0 : 1 - spring(time, at, { hz: 2.4, damp: 4 });
    const arrive = slide * slide;
    const chosen = i === PICKED;
    // The others slide off, each to its nearer side, one after another.
    const leave = chosen ? 0 : spring(time, bf(BEAT.pick) + 3 + i * 2, DEFAULT);
    const dir = i < PICKED ? -1 : 1;
    const collapse = chosen ? clamp(spring(time, bf(BEAT.nameFly) + 14, SNAPPY)) : 0;
    if (collapse > 0.995 || leave > 1.4) {
      return;
    }
    const b = nameCard(i);
    g.save();
    g.translate(dir * 1200 * leave + 900 * (1 - arrive) - 80 * settle, 0);
    about(g, b.x + b.w / 2, b.y + b.h / 2, (chosen ? (1 + 0.04 * pick) * (1 - collapse) : 1) * (1 + 0.08 * settle), (chosen ? 1 - collapse : 1) * (1 - 0.12 * settle));
    card(g, ui, b, 28);
    if (chosen && pick > 0) {
      g.strokeStyle = rgba(ui.text, clamp(pick));
      g.lineWidth = 4;
      roundRect(g, b.x - 4, b.y - 4, b.w + 8, b.h + 8, 32);
      g.stroke();
      // A check in a ring at the right.
      g.save();
      about(g, b.x + b.w - 60, b.y + b.h / 2, clamp(pick, 0, 1.2));
      g.fillStyle = ui.text;
      g.beginPath();
      g.arc(b.x + b.w - 60, b.y + b.h / 2, 24, 0, TAU);
      g.fill();
      g.strokeStyle = ui.card;
      g.lineWidth = 5;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(b.x + b.w - 71, b.y + b.h / 2);
      g.lineTo(b.x + b.w - 63, b.y + b.h / 2 + 8);
      g.lineTo(b.x + b.w - 48, b.y + b.h / 2 - 9);
      g.stroke();
      g.restore();
    }
    boxes.push(drawText(g, ctx, { id: `np-name-${String(i)}`, text: model, x: b.x + 36, y: b.y + 42, size: 26, face: 'sans', weight: 600, fill: ui.muted, role: 'imagery' }));
    if (!chosen || time < nameLaunch(0)) {
      boxes.push(drawText(g, ctx, { id: `name-${String(i)}`, text: name, x: b.x + 36, y: b.y + 100, size: NAME_TEXT_PX, face: 'serif', weight: 800, fill: ui.text, role: 'imagery' }));
    }
    g.restore();
  });
  // Her tap: a touch point comes down on the picked card and presses it on the pick frame.
  const touchIn = spring(time, bf(BEAT.pick) - 10, SNAPPY) - spring(time, bf(BEAT.pick) + 8, SNAPPY);
  if (touchIn > 0.01) {
    const b = nameCard(PICKED);
    const press = time >= bf(BEAT.pick) ? 1 - clamp(spring(time, bf(BEAT.pick) + 2, SNAPPY)) : 0;
    const tx = b.x + b.w - 60;
    const ty = b.y + b.h / 2 + 90 * (1 - clamp(touchIn));
    g.fillStyle = 'rgba(255,255,255,0.22)';
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(tx, ty, 40 * clamp(touchIn, 0, 1.1) * (1 - 0.2 * press), 0, TAU);
    g.fill();
    g.stroke();
  }
  // The picked name's letters fly from the card up onto the sign.
  if (time >= nameLaunch(0) && visible(cam, Z_FACADE)) {
    const letters = signLetters(g, ctx);
    const name = NAMES[PICKED].name;
    const b = nameCard(PICKED);
    const k = scaleAt(cam, Z_FACADE);
    letters.forEach(({ ch, x, y }, c) => {
      const launch = nameLaunch(c);
      const land = nameLand(c);
      if (time >= land) {
        return;
      }
      // Each letter jumps off the card fast and eases onto the sign.
      const raw = time < launch ? 0 : (time - launch) / (land - launch);
      const u = 1 - (1 - raw) * (1 - raw);
      const a = measure(g, ctx, name.slice(0, c), 'serif', 800, NAME_TEXT_PX);
      const sx = b.x + 36 + a;
      const sy = b.y + 100;
      const [tx, ty] = proj(cam, x, y, Z_FACADE);
      const size = lerp(NAME_TEXT_PX, SIGN_NAME_PX * k, u);
      g.save();
      g.translate(lerp(sx, tx, u), lerp(sy, ty, u) - 140 * Math.sin(Math.PI * u));
      g.font = fontOf(ctx, 'serif', lerp(800, 900, u), size);
      g.textAlign = u > 0.5 ? 'center' : 'left';
      g.fillStyle = mix(ui.text, '#fff4d4', u);
      if (!ctx.hideText) {
        g.fillText(ch, 0, 0);
      }
      g.restore();
    });
  }
  return boxes;
}

void W;
void H;
void Z_SCREEN;
