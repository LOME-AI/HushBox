import { copyBox, fontOf, glow, scribble } from './ink.js';
import { APP, GOLD, GOLD_HOT, TAU, clamp, hash, lerp, rgba } from './kit.js';
import { QUESTION } from './score.js';

import type { Boil } from './ink.js';
import type { G, Pt } from './kit.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

type Ctx = LookContext<'2d'>;

/** The phone, close: its body, its screen, and the regions of the chat on it, in the close-up's own px. */
export const PHONE = { x: 150, y: -40, w: 780, h: 1760, r: 100 };
export const SCREEN = { x: 172, y: -18, w: 736, h: 1716, r: 82 };
export const COMPOSER = { x: 196, w: 688, bottom: 1236, pad: 22, lineH: 70, font: 56 };
const TEXT_X = 226;
const WRAP = 570;
export const SEND: Pt = [842, 1182];
const SEND_R = 38;
const KEYS_TOP = 1262;
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'] as const;
const KEY_W = 61.6;
const KEY_GAP = 7.2;
const ROW_Y = [1318, 1414, 1510, 1606] as const;

/** Where a character's key sits, for the thumb to land on. */
export function keyCenter(ch: string): Pt {
  const c = ch.toLowerCase();
  for (let r = 0; r < ROWS.length; r++) {
    const row = ROWS[r] as string;
    const i = row.indexOf(c);
    if (i >= 0) {
      const offset = r === 0 ? 0 : r === 1 ? (KEY_W + KEY_GAP) / 2 : (KEY_W + KEY_GAP) * 1.5;
      return [COMPOSER.x + offset + i * (KEY_W + KEY_GAP) + KEY_W / 2, ROW_Y[r] as number];
    }
  }
  if (c === ' ') {
    return [540, ROW_Y[3]];
  }
  return [770, ROW_Y[3]];
}

export const BACKSPACE: Pt = [COMPOSER.x + COMPOSER.w - 44, ROW_Y[2]];

/** One character of the question as the composer lays it out. */
export interface Glyph {
  ch: string;
  x: number;
  w: number;
  /** The baseline. */
  y: number;
  line: number;
}

interface Layout {
  glyphs: Glyph[];
  lines: number;
  top: number;
}

let laidOut: Layout | null = null;

/** The question laid out in the composer, wrapped at word breaks; computed once, the fonts being loaded. */
export function questionLayout(g: G, ctx: Ctx): Layout {
  if (laidOut !== null) {
    return laidOut;
  }
  g.save();
  g.font = fontOf(ctx, 'sans', 500, COMPOSER.font);
  const words = QUESTION.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current === '' ? word : `${current} ${word}`;
    if (current !== '' && g.measureText(next).width > WRAP) {
      lines.push(`${current} `);
      current = word;
    } else {
      current = next;
    }
  }
  lines.push(current);
  const n = lines.length;
  const top = COMPOSER.bottom - COMPOSER.pad * 2 - n * COMPOSER.lineH;
  const glyphs: Glyph[] = [];
  lines.forEach((text, li) => {
    const y = top + COMPOSER.pad + (li + 1) * COMPOSER.lineH - 18;
    for (let i = 0; i < text.length; i++) {
      const before = g.measureText(text.slice(0, i)).width;
      const w = g.measureText(text.charAt(i)).width;
      glyphs.push({ ch: text.charAt(i), x: TEXT_X + before, w, y, line: li });
    }
  });
  g.restore();
  laidOut = { glyphs: glyphs.slice(0, QUESTION.length), lines: n, top };
  return laidOut;
}

/** What the phone shows on a frame. */
export interface PhoneView {
  /** Characters of the question in the composer. */
  typed: number;
  /** Whether the caret shows (blinks while idle). */
  caret: boolean;
  /** The Send button's squash on the press, 0 to 1. */
  press: number;
  /** The sent bubble's flight, 0 in the composer to 1 settled in the chat; -1 not sent. */
  sent: number;
  /** The first answer's arrival, 0 to 1; -1 not yet. */
  answer: number;
  /** Each chart bar's height, 0 to 1. */
  bars: readonly number[];
  /** The search answer's arrival, -1 not yet. */
  search: number;
  /** The source cards' fan, 0 stacked to 1 spread. */
  fan: number;
  /** Each source card's lift off the screen, 0 on it to 1 gone. */
  lifts?: readonly number[];
  /** The frame time the fanned cards sway by, so the fan never holds still. */
  sway?: number;
  /** How far the chat has scrolled, px. */
  scroll: number;
  /** Whether the keyboard shows. */
  keyboard: boolean;
  /** A key held down, for its highlight. */
  keyDown: Pt | null;
  /** Report the composer's text as copy under this id, or not at all. */
  copyId: string | null;
  /** How many leading characters that copy covers (the brief's line, or the whole question). */
  copyChars?: number;
  /** Report the sent bubble's text as copy under this id. */
  bubbleCopyId?: string | null;
  /** Report the search answer's nameplate and row as copy. */
  searchCopy?: boolean;
}

export const IDLE_VIEW: PhoneView = {
  typed: 0,
  caret: true,
  press: 0,
  sent: -1,
  answer: -1,
  bars: [0, 0, 0, 0],
  search: -1,
  fan: 0,
  scroll: 0,
  keyboard: true,
  keyDown: null,
  copyId: null,
};

/** The phone's body: dark, round-cornered, a hairline highlight. */
function body(g: G, ink: string): void {
  g.fillStyle = '#121016';
  g.beginPath();
  g.roundRect(PHONE.x, PHONE.y, PHONE.w, PHONE.h, PHONE.r);
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = ink;
  g.stroke();
  g.lineWidth = 2.5;
  g.strokeStyle = rgba('#8f96c4', 0.55);
  g.beginPath();
  g.roundRect(PHONE.x + 7, PHONE.y + 7, PHONE.w - 14, PHONE.h - 14, PHONE.r - 6);
  g.stroke();
}

/** The HushBox header: the mark, the wordmark, as the app draws them. */
function header(g: G, ctx: Ctx, brandRed: string, y: number): void {
  const size = 58;
  g.drawImage(ctx.logo.image, 222, y - size / 2, size, (size * ctx.logo.height) / ctx.logo.width);
  g.font = fontOf(ctx, 'serif', 700, 38);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = APP.fg;
  g.fillText('Hush', 296, y + 13);
  const w = g.measureText('Hush').width;
  g.fillStyle = brandRed;
  g.fillText('Box', 296 + w, y + 13);
  g.strokeStyle = rgba(APP.muted, 0.25);
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(SCREEN.x + 20, y + 52);
  g.lineTo(SCREEN.x + SCREEN.w - 20, y + 52);
  g.stroke();
}

function keyboard(g: G, ctx: Ctx, down: Pt | null): void {
  g.fillStyle = '#211f1c';
  g.fillRect(SCREEN.x, KEYS_TOP, SCREEN.w, 1686 - KEYS_TOP);
  g.font = fontOf(ctx, 'sans', 500, 30);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const key = (cx: number, cy: number, w: number, label: string): void => {
    const pressed = down !== null && Math.abs(down[0] - cx) < w / 2 && Math.abs(down[1] - cy) < 40;
    g.fillStyle = pressed ? '#55504a' : APP.subtle;
    g.beginPath();
    g.roundRect(cx - w / 2, cy - 40, w, 80, 12);
    g.fill();
    g.fillStyle = rgba(APP.fg, 0.82);
    g.fillText(label, cx, cy + 1);
  };
  ROWS.forEach((row, r) => {
    for (const ch of row) {
      const [cx, cy] = keyCenter(ch);
      key(cx, cy, KEY_W, ch);
    }
    void r;
  });
  key(COMPOSER.x + 44, ROW_Y[2], 88, '⇧');
  key(BACKSPACE[0], BACKSPACE[1], 88, '⌫');
  key(COMPOSER.x + 70, ROW_Y[3], 140, '123');
  key(540, ROW_Y[3], 300, '');
  key(770, ROW_Y[3], KEY_W, '?');
  key(COMPOSER.x + COMPOSER.w - 60, ROW_Y[3], 120, '↵');
}

/** The composer: its box, the typed text, the caret, the Send button. Returns the copy box when asked. */
function composer(g: G, ctx: Ctx, v: PhoneView, time: number, brandRed: string): TextBox[] {
  const lay = questionLayout(g, ctx);
  const lines = Math.max(1, v.typed === 0 ? 1 : (lay.glyphs[Math.max(0, v.typed - 1)]?.line ?? 0) + 1);
  const top = COMPOSER.bottom - COMPOSER.pad * 2 - lines * COMPOSER.lineH;
  g.fillStyle = APP.paper;
  g.strokeStyle = rgba(APP.muted, 0.35);
  g.lineWidth = 2;
  g.beginPath();
  g.roundRect(COMPOSER.x, top, COMPOSER.w, COMPOSER.bottom - top, 34);
  g.fill();
  g.stroke();
  const boxes: TextBox[] = [];
  const shown = lay.glyphs.slice(0, v.typed);
  // Lines drawn from the layout of the whole question, offset to the box as it grows.
  const dy = top - lay.top - (lay.lines - lines) * 0;
  const yOf = (gl: { y: number; line: number }): number => top + COMPOSER.pad + (gl.line + 1) * COMPOSER.lineH - 18;
  g.font = fontOf(ctx, 'sans', 500, COMPOSER.font);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  if (!ctx.hideText || v.copyId === null) {
    g.fillStyle = APP.fg;
    for (let li = 0; li < lines; li++) {
      const row = shown.filter((gl) => gl.line === li);
      const first = row[0];
      if (first !== undefined) {
        g.fillText(row.map((gl) => gl.ch).join(''), first.x, yOf(first));
      }
    }
  }
  const last = shown.at(-1);
  if (v.caret && Math.floor(time / 30) % 2 === 0) {
    const cx = last === undefined ? TEXT_X : last.x + last.w + 3;
    const cy = last === undefined ? yOf({ y: 0, line: 0 }) : yOf(last);
    g.fillStyle = APP.fg;
    g.fillRect(cx, cy - 46, 5, 58);
  }
  if (v.copyId !== null && v.typed > 0) {
    const n = Math.min(v.typed, v.copyChars ?? QUESTION.length);
    const covered = lay.glyphs.slice(0, n);
    const right = Math.max(...covered.map((gl) => gl.x + gl.w));
    const lastLine = Math.max(...covered.map((gl) => gl.line));
    const boxTop = yOf({ y: 0, line: 0 }) - COMPOSER.font * 0.78;
    const boxBottom = yOf({ y: 0, line: lastLine }) + COMPOSER.font * 0.24;
    boxes.push(copyBox(g, v.copyId, QUESTION.slice(0, v.copyChars ?? QUESTION.length), 'support', TEXT_X - 2, boxTop, right - TEXT_X + 4, boxBottom - boxTop, COMPOSER.font));
  }
  void dy;
  // Send: Signal Red, the app's own; it squashes on the press.
  const r = SEND_R * (1 - 0.18 * v.press);
  g.fillStyle = v.typed > 0 ? brandRed : rgba(APP.muted, 0.35);
  g.beginPath();
  g.arc(SEND[0], SEND[1], r, 0, TAU);
  g.fill();
  g.strokeStyle = APP.fg;
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(SEND[0], SEND[1] + r * 0.45);
  g.lineTo(SEND[0], SEND[1] - r * 0.45);
  g.moveTo(SEND[0] - r * 0.38, SEND[1] - r * 0.08);
  g.lineTo(SEND[0], SEND[1] - r * 0.45);
  g.lineTo(SEND[0] + r * 0.38, SEND[1] - r * 0.08);
  g.stroke();
  return boxes;
}

/** A reply's nameplate, small and muted, as the app sets it. */
export function nameplate(g: G, ctx: Ctx, name: string, x: number, y: number, size = 24, alpha = 1): void {
  g.font = fontOf(ctx, 'sans', 600, size);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = rgba(APP.muted, 0.9 * alpha);
  g.fillText(name, x, y);
}

const BUBBLE_LINES = ['Is it crazy to quit my', 'job to open a cinema?'] as const;
const BUBBLE_PX = 42;

/** The sent message: a bubble rising from the composer to the top right, holding the question. */
function sentBubble(g: G, ctx: Ctx, v: PhoneView): TextBox[] {
  if (v.sent < 0) {
    return [];
  }
  const u = v.sent;
  // It flies on an arc, bowing right as it rises, leaning into the turn and stretched along its flight.
  const arc = Math.sin(Math.PI * clamp(u));
  const y = lerp(COMPOSER.bottom - 230, 186, u) - v.scroll;
  const x = lerp(COMPOSER.x, 330, clamp(u)) + 60 * arc;
  const w = lerp(COMPOSER.w, 554, clamp(u));
  g.save();
  g.translate(x + w / 2, y + 80);
  g.rotate(-0.07 * arc);
  g.scale(1 - 0.06 * arc, 1 + 0.12 * arc);
  g.translate(-(x + w / 2), -(y + 80));
  const boxes = bubbleBody(g, ctx, v, x, y, w);
  g.restore();
  return boxes;
}

/** The bubble at its place, with the question's two lines; returns its copy box when reported. */
function bubbleBody(g: G, ctx: Ctx, v: PhoneView, x: number, y: number, w: number): TextBox[] {
  g.fillStyle = APP.subtle;
  g.beginPath();
  g.roundRect(x, y, w, 160, 30);
  g.fill();
  g.font = fontOf(ctx, 'sans', 500, BUBBLE_PX);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  if (!ctx.hideText || !v.bubbleCopyId) {
    g.fillStyle = APP.fg;
    BUBBLE_LINES.forEach((text, i) => {
      g.fillText(text, x + 30, y + 66 + i * 54);
    });
  }
  if (!v.bubbleCopyId) {
    return [];
  }
  const width = Math.max(...BUBBLE_LINES.map((l) => g.measureText(l).width));
  return [copyBox(g, v.bubbleCopyId, QUESTION, 'support', x + 28, y + 66 - BUBBLE_PX * 0.78, width + 4, 54 + BUBBLE_PX * 1.02, BUBBLE_PX)];
}

/** The first answer: a GPT-5.5 nameplate, two lines, a code block, and the chart the code draws. */
function codeAnswer(g: G, ctx: Ctx, v: PhoneView, time: number, b: Boil): void {
  if (v.answer < 0) {
    return;
  }
  const a = clamp(v.answer);
  const y0 = 440 - v.scroll + (1 - a) * 90;
  g.save();
  g.globalAlpha = clamp(a * 1.6);
  nameplate(g, ctx, 'GPT-5.5', 222, y0, 30);
  scribble(g, 212, y0 + 44, 600, 2, 34, rgba(APP.fg, 0.75), 6, 11, b);
  // The code block.
  g.fillStyle = '#100e0d';
  g.beginPath();
  g.roundRect(204, y0 + 120, 672, 150, 18);
  g.fill();
  const colors = ['#9fc7ff', '#e9c46a', '#b8e0a6', '#9fc7ff'];
  colors.forEach((c, i) => {
    const run = clamp((time - (BAR_FRAME0 - 16) - i * 3) / 10);
    g.strokeStyle = rgba(c, 0.85);
    g.lineWidth = 9;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(232, y0 + 152 + i * 30);
    g.lineTo(232 + (180 + 260 * hash(i, 5)) * (0.4 + 0.6 * run), y0 + 152 + i * 30);
    g.stroke();
  });
  // The chart panel: axes and four bars.
  const cx = 204;
  const cy = y0 + 290;
  g.fillStyle = '#f4ecd9';
  g.beginPath();
  g.roundRect(cx, cy, 672, 330, 18);
  g.fill();
  g.strokeStyle = '#3a3028';
  g.lineWidth = 4;
  g.lineJoin = 'miter';
  g.beginPath();
  g.moveTo(cx + 60, cy + 30);
  g.lineTo(cx + 60, cy + 290);
  g.lineTo(cx + 630, cy + 290);
  g.stroke();
  v.bars.forEach((h, i) => {
    const bw = 92;
    const bx = cx + 110 + i * 130;
    const bh = 230 * [0.45, 0.62, 0.8, 1][i]! * h;
    if (bh > 1) {
      g.fillStyle = GOLD;
      g.fillRect(bx, cy + 290 - bh, bw, bh);
      g.strokeStyle = '#3a3028';
      g.lineWidth = 4;
      g.strokeRect(bx, cy + 290 - bh, bw, bh);
    }
  });
  g.restore();
}

/** Frame the chart's code starts running; the look sets it from the score's bar beats. */
let BAR_FRAME0 = 504;
export function setBarFrame(frame: number): void {
  BAR_FRAME0 = frame;
}

/** Where the chart's bars stand, in the close-up's px, for the bars to leave the screen from. */
export function barRects(v: PhoneView): { x: number; y: number; w: number; h: number }[] {
  const y0 = 440 - v.scroll;
  const cy = y0 + 290;
  return v.bars.map((h, i) => {
    const bh = 230 * [0.45, 0.62, 0.8, 1][i]! * h;
    return { x: 204 + 110 + i * 130, y: cy + 290 - bh, w: 92, h: bh };
  });
}

/** The search answer: a Gemini 3.1 Pro nameplate, the row, and six source cards fanning out. */
function searchAnswer(g: G, ctx: Ctx, v: PhoneView, b: Boil): TextBox[] {
  if (v.search < 0) {
    return [];
  }
  const a = v.search;
  const y0 = SEARCH_Y - v.scroll + (1 - a) * 120;
  const boxes: TextBox[] = [];
  // The sources under the read, so a card lifting past never covers the words.
  for (let i = 0; i < 6; i++) {
    const r = sourceCard(v, i);
    if (r.gone) {
      continue;
    }
    drawSourceCard(g, r.x, r.y, r.w, r.h, r.rot, i, clamp(a * 1.6), b);
  }
  g.save();
  g.globalAlpha = clamp(a * 2.5);
  g.font = fontOf(ctx, 'sans', 600, 34);
  if (!ctx.hideText || v.searchCopy !== true) {
    nameplate(g, ctx, 'Gemini 3.1 Pro', 222, y0, 34);
  }
  if (v.searchCopy === true) {
    g.font = fontOf(ctx, 'sans', 600, 34);
    const m = g.measureText('Gemini 3.1 Pro');
    boxes.push(copyBox(g, 'search-model', 'Gemini 3.1 Pro', 'support', 220, y0 - 28, m.width + 4, 38, 34));
  }
  // The row: a globe and the words, as the app writes them.
  const gx = 240;
  const gy = y0 + 66;
  g.strokeStyle = APP.fg;
  g.lineWidth = 3.5;
  g.beginPath();
  g.arc(gx, gy, 16, 0, TAU);
  g.moveTo(gx - 16, gy);
  g.lineTo(gx + 16, gy);
  g.moveTo(gx, gy - 16);
  g.ellipse(gx, gy, 7, 16, 0, -Math.PI / 2, Math.PI * 1.5);
  g.stroke();
  g.font = fontOf(ctx, 'sans', 500, 40);
  g.fillStyle = APP.fg;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  const row = 'Searched the web \u00b7 6 sources';
  if (!ctx.hideText || v.searchCopy !== true) {
    g.fillText(row, 274, gy + 2);
  }
  if (v.searchCopy === true) {
    const m = g.measureText(row);
    boxes.push(copyBox(g, 'search-row', row, 'support', 272, gy - 22, m.width + 4, 46, 40));
  }
  g.restore();
  return boxes;
}

const SEARCH_Y = 1320;

/** A source card's place: stacked under the row, fanned in an arc, then each lifted off the screen on its own. */
export function sourceCard(v: PhoneView, i: number): { x: number; y: number; w: number; h: number; rot: number; gone: boolean } {
  const y0 = SEARCH_Y - v.scroll + (1 - clamp(v.search)) * 120;
  const k = i - 2.5;
  const fan = v.fan;
  const lift = v.lifts?.[i] ?? 0;
  // Fanned, each card sways on its own slow phase, so the spread never holds still.
  const t = v.sway ?? 0;
  const sway = clamp(fan) * (1 - lift);
  return {
    x: 300 + i * 4 + fan * (k * 104 + 40) + lift * k * 60 + sway * 6 * Math.sin(t * 0.05 + i * 1.9),
    y: y0 + 150 + i * 4 + fan * Math.abs(k) * 14 - lift * lift * 1400 + sway * 12 * Math.sin(t * 0.07 + i * 2.3),
    w: 168 * (1 + lift * 0.8),
    h: 110 * (1 + lift * 0.8),
    rot: fan * k * 0.07 + lift * (i % 2 === 0 ? 0.6 : -0.5) + sway * 0.07 * Math.sin(t * 0.06 + i * 1.3),
    gone: lift >= 1,
  };
}

/** A source: a small page with a favicon and two lines. */
export function drawSourceCard(g: G, x: number, y: number, w: number, h: number, rot: number, i: number, alpha: number, b: Boil | null): void {
  g.save();
  g.globalAlpha = alpha;
  g.translate(x + w / 2, y + h / 2);
  g.rotate(rot);
  g.fillStyle = '#f4ecd9';
  g.strokeStyle = '#3a3028';
  g.lineWidth = 3.5;
  g.beginPath();
  g.roundRect(-w / 2, -h / 2, w, h, 12);
  g.fill();
  g.stroke();
  const hue = ['#6aa7d8', '#7bbf86', '#e0a14a', '#9a86d6', '#58b3b0', '#d68a6a'][i % 6] as string;
  g.fillStyle = hue;
  g.beginPath();
  g.arc(-w / 2 + 24, -h / 2 + 26, 11, 0, TAU);
  g.fill();
  scribble(g, -w / 2 + 44, -h / 2 + 26, w - 64, 1, 0, '#3a3028', 5, i * 3, b);
  scribble(g, -w / 2 + 18, -h / 2 + 62, w - 36, 2, 22, rgba('#3a3028', 0.6), 4, i * 3 + 1, b);
  g.restore();
}

/** The whole phone, close: body, screen, header, chat, composer, keyboard. Returns copy boxes. */
export function drawPhone(g: G, ctx: Ctx, v: PhoneView, time: number, ink: string, brandRed: string, b: Boil): TextBox[] {
  body(g, ink);
  g.save();
  g.beginPath();
  g.roundRect(SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h, SCREEN.r);
  g.clip();
  g.fillStyle = APP.bg;
  g.fillRect(SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h);
  // The chat, scrolled.
  const chat = sentBubble(g, ctx, v);
  codeAnswer(g, ctx, v, time, b);
  chat.push(...searchAnswer(g, ctx, v, b));
  // Header and composer sit over the scrolled chat.
  g.fillStyle = APP.bg;
  g.fillRect(SCREEN.x, SCREEN.y, SCREEN.w, 160);
  header(g, ctx, brandRed, 96);
  const boxes: TextBox[] = [...chat];
  if (v.keyboard) {
    boxes.push(...composer(g, ctx, v, time, brandRed));
    keyboard(g, ctx, v.keyDown);
  }
  g.restore();
  // The screen's own light on the glass edge.
  glow(g, 540, 700, 900, GOLD_HOT, 0.04);
  return boxes;
}
