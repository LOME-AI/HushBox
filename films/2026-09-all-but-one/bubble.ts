import { clamp, hash, hs, rgba } from './kit.js';
import { fontOf, imagery } from './type.js';

import type { G } from './kit.js';
import type { LookContext, TextBox } from '../engine/look/index.js';

type Ctx = LookContext<'2d'>;

export interface Message {
  id: string;
  text: string;
  x: number;
  y: number;
  /** Uniform scale; 1 draws the bubble at its natural size (text 40 px). */
  scale: number;
  rotate?: number;
  /** 0 a plain chat bubble; 1 a demon: horns, a head of shadow, slit eyes and teeth biting the bubble. */
  demon?: number;
  /** How far the demon's jaw has opened, 0 to 1. */
  jaw?: number;
  /** When set, the text is scrambled cipher and a padlock in this colour sits on the bubble. */
  lock?: string | null;
  /** Letters already scrambled, 0 to 1. */
  scramble?: number;
  /** Squash on impact: positive flattens and widens the bubble, negative stretches it tall. */
  squash?: number;
  /** The glow around the bubble, 0 to 1: a live message pulled out of the air. */
  glow?: number;
  seed?: number;
}

const NOISE = '▓▒░#%&@$*+=?<>/{}[]01ABCDEF';
const TEXT_PX = 40;
const PAD_X = 34;
const PAD_Y = 26;

/** The message with its first `share` of letters scrambled, re-rolling a few times a second. */
function scrambledText(text: string, share: number, time: number, seed: number): string {
  // Keyed to the frame, not the sub-frame instant, so every motion-blur sample reports the same words.
  const roll = Math.floor((Math.round(time) / 60) * 8);
  const chars = Array.from(text.matchAll(/./gsu), ([ch]) => ch);
  const cut = Math.floor(clamp(share) * chars.length);
  return chars
    .map((ch, index) =>
      ch === ' ' || index >= cut
        ? ch
        : (NOISE[Math.floor(hash(index * 13 + roll * 7 + seed, 9) * NOISE.length)] ?? '#')
    )
    .join('');
}

/** The bubble's box in its own space, centred on its origin and raised as the jaw opens. */
interface Bubble {
  bx: number;
  by: number;
  w: number;
  h: number;
}

/** Puts the message's place, turn, scale and squash on `g`. */
function placeMessage(g: G, m: Message): void {
  const squash = m.squash ?? 0;
  g.translate(m.x, m.y);
  g.rotate(m.rotate ?? 0);
  g.scale(m.scale * (1 + squash), m.scale * (1 - squash));
}

/** The head behind the bubble, rising out of it: a skull of shadow with horns. */
function demonHead(
  g: G,
  { bx, by, w, h }: Bubble,
  { rise, time, seed }: { rise: number; time: number; seed: number }
): void {
  const top = by - 150 * rise;
  g.fillStyle = '#0b0202';
  g.strokeStyle = rgba('#ff5a14', 0.9);
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(bx - 20, by + h);
  g.quadraticCurveTo(bx - 40, top + 40, 0, top);
  g.quadraticCurveTo(-bx + 40, top + 40, -bx + 20, by + h);
  g.closePath();
  g.fill();
  g.stroke();
  for (const side of [-1, 1]) {
    horn(g, { side, rise, hx: side * (w * 0.32), hy: top + 30 });
  }
  // Two slit eyes, unequal, the right blinking on its own clock.
  const blink = ((time + hash(seed, 3) * 80) / (60 + 40 * hash(seed, 4))) % 1 < 0.08 ? 0.15 : 1;
  for (const side of [-1, 1]) {
    slitEye(g, { side, rise, blink, ex: side * w * 0.17, ey: top + 70 * rise });
  }
}

/** One horn of the demon's head, the left one taller. */
function horn(
  g: G,
  { side, rise, hx, hy }: { side: number; rise: number; hx: number; hy: number }
): void {
  const lead = side < 0;
  const length = (lead ? 150 : 120) * rise;
  g.beginPath();
  g.moveTo(hx - 22, hy + 20);
  g.quadraticCurveTo(hx + side * 70, hy - length * 0.4, hx + side * (lead ? 40 : 20), hy - length);
  g.quadraticCurveTo(hx + side * 30, hy - length * 0.3, hx + 22, hy + 14);
  g.closePath();
  g.fill();
  g.stroke();
}

/** One slit eye of the demon's head: the left wider, the right blinking. */
function slitEye(
  g: G,
  {
    side,
    rise,
    blink,
    ex,
    ey,
  }: { side: number; rise: number; blink: number; ex: number; ey: number }
): void {
  const lead = side < 0;
  const ew = (lead ? 38 : 30) * rise;
  const eh = (lead ? 12 : 9) * rise * (lead ? 1 : blink);
  g.fillStyle = '#ffd23a';
  g.beginPath();
  g.moveTo(ex - ew, ey - side * 4);
  g.quadraticCurveTo(ex, ey - eh * 2, ex + ew, ey + side * 4);
  g.quadraticCurveTo(ex, ey + eh * 2, ex - ew, ey - side * 4);
  g.fill();
  g.fillStyle = '#1a0500';
  g.fillRect(ex - 2, ey - eh * 1.5, 4, eh * 3);
}

/** The bubble itself: its glow, its body and tail, and two read ticks on a plain message. */
function bubbleBody(
  g: G,
  { bx, by, w, h }: Bubble,
  { m, demon }: { m: Message; demon: number }
): void {
  const glow = clamp(m.glow ?? 0);
  if (glow > 0) {
    g.fillStyle = rgba('#fff4d6', 0.12 * glow);
    g.beginPath();
    g.roundRect(bx - 30, by - 30, w + 60, h + 60, 60);
    g.fill();
  }
  const locked = m.lock != null;
  g.fillStyle = locked ? '#1d1a18' : '#f4efe6';
  g.strokeStyle = m.lock ?? (demon > 0 ? '#ff5a14' : '#f4efe6');
  g.lineWidth = locked ? 6 : 3;
  g.beginPath();
  g.roundRect(bx, by, w, h, 34);
  g.fill();
  g.stroke();
  g.beginPath();
  g.moveTo(bx + 30, by + h - 4);
  g.lineTo(bx + 6, by + h + 26);
  g.lineTo(bx + 62, by + h - 4);
  g.closePath();
  g.fill();
  if (locked) {
    return;
  }
  // Two read ticks.
  g.strokeStyle = '#3d7bd9';
  g.lineWidth = 3;
  for (const dx of [0, 10]) {
    g.beginPath();
    g.moveTo(-bx - 44 + dx, by + h - 16);
    g.lineTo(-bx - 38 + dx, by + h - 10);
    g.lineTo(-bx - 26 + dx, by + h - 24);
    g.stroke();
  }
}

/** Teeth biting the bubble: a row down from the head over its top edge, a row up over its bottom. */
function teeth(
  g: G,
  { bx, by, w, h }: Bubble,
  { demon, jaw, seed }: { demon: number; jaw: number; seed: number }
): void {
  g.fillStyle = '#f7ecd2';
  const n = Math.max(6, Math.round(w / 38));
  for (let index = 0; index < n; index++) {
    const x = bx + 18 + ((w - 36) * (index + 0.5)) / n;
    const length = (16 + 16 * hash(index + seed * 17, 5)) * demon;
    g.beginPath();
    g.moveTo(x - 8, by - 2);
    g.lineTo(x + hs(index, 6) * 3, by + length);
    g.lineTo(x + 8, by - 2);
    g.fill();
    const lowY = by + h + jaw * 36;
    const lowLength = (12 + 14 * hash(index + seed * 31, 7)) * demon;
    g.beginPath();
    g.moveTo(x - 7 + 10, lowY + 2);
    g.lineTo(x + 10 + hs(index, 8) * 3, lowY - lowLength);
    g.lineTo(x + 7 + 10, lowY + 2);
    g.fill();
  }
}

/** The padlock on a locked message, at the bubble's top right. */
function bubbleLock(g: G, { bx, by }: Bubble, lock: string): void {
  const lx = -bx - 30;
  const ly = by - 6;
  g.strokeStyle = lock;
  g.fillStyle = lock;
  g.lineWidth = 6;
  g.beginPath();
  g.arc(lx, ly - 8, 14, Math.PI, 0);
  g.stroke();
  g.fillRect(lx - 20, ly - 8, 40, 30);
}

/** A message's face and words: its own words in sans, or cipher in mono when it is locked. */
function messageWords(
  m: Message,
  time: number,
  seed: number
): { face: 'sans' | 'mono'; words: string } {
  if (m.lock == null) {
    return { face: 'sans', words: m.text };
  }
  return { face: 'mono', words: scrambledText(m.text, m.scramble ?? 1, time, seed) };
}

/**
 * A leaked message: a chat bubble with its text, the sender's words, and two
 * read ticks. As `demon` rises it grows a head of shadow behind it, horns, two
 * unequal slit eyes over the bubble and rows of teeth biting its top and bottom
 * edges; the words stay readable in its jaws.
 */
export function message(g: G, ctx: Ctx, time: number, m: Message): TextBox {
  const seed = m.seed ?? 1;
  const demon = clamp(m.demon ?? 0);
  const jaw = clamp(m.jaw ?? 0);
  const { face, words } = messageWords(m, time, seed);
  g.save();
  placeMessage(g, m);
  g.font = fontOf(ctx, face, 600, TEXT_PX);
  const w = Math.max(220, g.measureText(words).width) + 2 * PAD_X;
  const h = TEXT_PX + 2 * PAD_Y;
  const bubble = { bx: -w / 2, by: -h / 2 - jaw * 18, w, h };
  if (demon > 0) {
    demonHead(g, bubble, { rise: demon, time, seed });
  }
  bubbleBody(g, bubble, { m, demon });
  if (demon > 0) {
    teeth(g, bubble, { demon, jaw, seed });
  }
  g.restore();
  g.save();
  placeMessage(g, m);
  const box = imagery(g, ctx, {
    id: m.id,
    text: words,
    x: 0,
    y: bubble.by + h / 2 + TEXT_PX * 0.35,
    size: TEXT_PX,
    face,
    weight: 600,
    fill: m.lock ?? '#161310',
    align: 'center',
  });
  if (m.lock != null) {
    bubbleLock(g, bubble, m.lock);
  }
  g.restore();
  return box;
}
