import { TAU, clamp, hash, hs, lerp, rgba } from './kit.js';
import { fontOf, imagery } from './type.js';

import type { G } from './kit.js';
import type { LookContext, TextBox } from '../../../../engine/look/index.js';

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
  const chars = [...text];
  const cut = Math.floor(clamp(share) * chars.length);
  return chars
    .map((ch, i) => (ch === ' ' || i >= cut ? ch : (NOISE[Math.floor(hash(i * 13 + roll * 7 + seed, 9) * NOISE.length)] ?? '#')))
    .join('');
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
  const words = m.lock != null ? scrambledText(m.text, m.scramble ?? 1, time, seed) : m.text;
  g.save();
  g.translate(m.x, m.y);
  g.rotate(m.rotate ?? 0);
  g.scale(m.scale * (1 + (m.squash ?? 0)), m.scale * (1 - (m.squash ?? 0)));
  g.font = fontOf(ctx, m.lock != null ? 'mono' : 'sans', 600, TEXT_PX);
  const w = Math.max(220, g.measureText(words).width) + 2 * PAD_X;
  const h = TEXT_PX + 2 * PAD_Y;
  const bx = -w / 2;
  const by = -h / 2 - jaw * 18;
  if (demon > 0) {
    // The head behind the bubble, rising out of it: a skull of shadow with horns.
    const rise = demon;
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
      const lead = side < 0;
      const len = (lead ? 150 : 120) * rise;
      const hx = side * (w * 0.32);
      const hy = top + 30;
      g.beginPath();
      g.moveTo(hx - 22, hy + 20);
      g.quadraticCurveTo(hx + side * 70, hy - len * 0.4, hx + side * (lead ? 40 : 20), hy - len);
      g.quadraticCurveTo(hx + side * 30, hy - len * 0.3, hx + 22, hy + 14);
      g.closePath();
      g.fill();
      g.stroke();
    }
    // Two slit eyes, unequal, the right blinking on its own clock.
    const blink = ((time + hash(seed, 3) * 80) / (60 + 40 * hash(seed, 4))) % 1 < 0.08 ? 0.15 : 1;
    for (const side of [-1, 1]) {
      const lead = side < 0;
      const ex = side * w * 0.17;
      const ey = top + 70 * rise;
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
  }
  // The bubble.
  const glow = clamp(m.glow ?? 0);
  if (glow > 0) {
    g.fillStyle = rgba('#fff4d6', 0.12 * glow);
    g.beginPath();
    g.roundRect(bx - 30, by - 30, w + 60, h + 60, 60);
    g.fill();
  }
  g.fillStyle = m.lock != null ? '#1d1a18' : '#f4efe6';
  g.strokeStyle = m.lock ?? (demon > 0 ? '#ff5a14' : '#f4efe6');
  g.lineWidth = m.lock != null ? 6 : 3;
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
  if (m.lock == null) {
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
  if (demon > 0) {
    // Teeth biting the bubble: a row down from the head over its top edge, a row up over its bottom.
    g.fillStyle = '#f7ecd2';
    const n = Math.max(6, Math.round(w / 38));
    for (let i = 0; i < n; i++) {
      const x = bx + 18 + ((w - 36) * (i + 0.5)) / n;
      const len = (16 + 16 * hash(i + seed * 17, 5)) * demon;
      g.beginPath();
      g.moveTo(x - 8, by - 2);
      g.lineTo(x + hs(i, 6) * 3, by + len);
      g.lineTo(x + 8, by - 2);
      g.fill();
      const lowY = by + h + jaw * 36;
      const lowLen = (12 + 14 * hash(i + seed * 31, 7)) * demon;
      g.beginPath();
      g.moveTo(x - 7 + 10, lowY + 2);
      g.lineTo(x + 10 + hs(i, 8) * 3, lowY - lowLen);
      g.lineTo(x + 7 + 10, lowY + 2);
      g.fill();
    }
  }
  g.restore();
  g.save();
  g.translate(m.x, m.y);
  g.rotate(m.rotate ?? 0);
  g.scale(m.scale * (1 + (m.squash ?? 0)), m.scale * (1 - (m.squash ?? 0)));
  const box = imagery(g, ctx, {
    id: m.id,
    text: words,
    x: 0,
    y: by + h / 2 + TEXT_PX * 0.35,
    size: TEXT_PX,
    face: m.lock != null ? 'mono' : 'sans',
    weight: 600,
    fill: m.lock != null ? m.lock : '#161310',
    align: 'center',
  });
  if (m.lock != null) {
    const lx = -bx - 30;
    const ly = by - 6;
    g.strokeStyle = m.lock;
    g.fillStyle = m.lock;
    g.lineWidth = 6;
    g.beginPath();
    g.arc(lx, ly - 8, 14, Math.PI, 0);
    g.stroke();
    g.fillRect(lx - 20, ly - 8, 40, 30);
  }
  g.restore();
  return box;
}

/** Where a message on a closed-form flight is `u` seconds after launch: out from (x0, y0) along its seeded arc. */
export function flight(i: number, u: number, x0: number, y0: number, spread = 1): [number, number] {
  const a = -Math.PI / 2 + hs(i, 21) * 1.3 * spread;
  const speed = 360 + 320 * hash(i, 22);
  const r = speed * u * (1 + 0.5 * u);
  const swirl = Math.sin(u * (3 + 2 * hash(i, 23)) + i) * 80 * u;
  return [x0 + Math.cos(a) * r + Math.cos(a + Math.PI / 2) * swirl, y0 + Math.sin(a) * r * 0.9 + Math.sin(a + Math.PI / 2) * swirl];
}

void TAU;
void lerp;
