import { P, W, beatPulse, boil, clamp, hash, rgba, wander } from './kit.js';
import { fontOf, glyph, metric, screenBox, screenScale } from './type.js';

import type { G } from './kit.js';
import type { Ctx } from './type.js';
import type { TextBox } from '../../../../engine/look/index.js';

/** The room's floor line, in its world space. */
export const FLOOR = 1580;

/** The night room: a deep wall papered with faint plus signs, a window made of a hash with a C for a moon, and a floor of underscores. */
export function room(g: G, ctx: Ctx, time: number, opts: { moon: number; day?: number; window?: { x: number; y: number; size: number } }): void {
  const grad = g.createLinearGradient(0, -400, 0, 2400);
  grad.addColorStop(0, P.ink);
  grad.addColorStop(0.55, P.night);
  grad.addColorStop(1, P.night2);
  g.fillStyle = grad;
  g.fillRect(-1200, -1200, W + 2400, 4400);
  // Wallpaper: a lattice of faint plus signs, each breathing on its own phase.
  for (let row = 0; row < 15; row++) {
    for (let col = 0; col < 8; col++) {
      const k = row * 8 + col;
      const x = -40 + col * 160 + (row % 2) * 80;
      const y = -100 + row * 120;
      if (y > FLOOR - 40) {
        continue;
      }
      glyph(g, ctx, '+', x, y, 34, { face: 'sans', weight: 300, color: P.lilac, alpha: 0.07 + 0.04 * wander(time / 40, k) });
    }
  }
  const win = opts.window ?? { x: 800, y: 900, size: 520 };
  // The window: one big hash, its middle cell holding the night sky.
  glyph(g, ctx, '#', win.x, win.y, win.size, { face: 'sans', weight: 200, color: P.lilac, alpha: 0.32 });
  for (let k = 0; k < 9; k++) {
    const sx = win.x + (hash(k, 41) - 0.5) * win.size * 0.42;
    const sy = win.y + (hash(k, 42) - 0.5) * win.size * 0.42;
    const tw = 0.4 + 0.6 * Math.abs(Math.sin(time * 0.05 + k * 1.7));
    glyph(g, ctx, k % 3 === 0 ? '*' : '·', sx, sy, k % 3 === 0 ? 30 : 40, { face: 'sans', weight: 600, color: P.cream, alpha: 0.5 * tw });
  }
  const moonX = win.x - win.size * 0.16 + opts.moon * win.size * 0.3;
  const moonY = win.y - win.size * 0.12 + Math.abs(opts.moon - 0.5) * win.size * 0.16;
  glyph(g, ctx, 'C', moonX, moonY, win.size * 0.22, { face: 'sans', weight: 900, color: P.amberHot, rot: -0.5 });
  const day = opts.day ?? 0;
  if (day > 0) {
    // A day passing: the room floods with pale light, a shaft from the window across the floor.
    g.fillStyle = rgba('#b9c8ff', 0.55 * day);
    g.fillRect(-1200, -1200, W + 2400, 4400);
    g.fillStyle = rgba('#fff4d6', 0.5 * day);
    g.beginPath();
    g.moveTo(win.x - win.size * 0.3, win.y - win.size * 0.3);
    g.lineTo(win.x + win.size * 0.3, win.y - win.size * 0.3);
    g.lineTo(win.x - win.size * 0.2, FLOOR + 200);
    g.lineTo(win.x - win.size * 1.4, FLOOR + 200);
    g.closePath();
    g.fill();
    glyph(g, ctx, 'O', win.x, win.y, win.size * 0.3, { face: 'sans', weight: 900, color: '#fff4d6', alpha: day });
  }
  // The floor: a run of underscores, boards of equals signs under it.
  for (let x = -600; x < W + 600; x += 44) {
    glyph(g, ctx, '_', x, FLOOR + 4, 60, { face: 'mono', weight: 700, color: P.lilac, alpha: 0.5 });
  }
  for (let row = 0; row < 5; row++) {
    for (let x = -600 + (row % 2) * 60; x < W + 600; x += 120) {
      glyph(g, ctx, '=', x, FLOOR + 70 + row * 80, 70, { face: 'mono', weight: 400, color: P.lilac, alpha: 0.1 + 0.02 * row });
    }
  }
}

/** Her phone's light: a soft cone from her hands up towards the composer. */
export function phoneGlow(g: G, x: number, y: number, toY: number, strength: number): void {
  const grad = g.createLinearGradient(0, y, 0, toY);
  grad.addColorStop(0, rgba(P.teal, 0.22 * strength));
  grad.addColorStop(1, rgba(P.teal, 0));
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(x - 30, y);
  g.lineTo(x + 30, y);
  g.lineTo(x + 520, toY);
  g.lineTo(x - 520, toY);
  g.closePath();
  g.fill();
  const halo = g.createRadialGradient(x, y, 0, x, y, 160);
  halo.addColorStop(0, rgba(P.teal, 0.35 * strength));
  halo.addColorStop(1, rgba(P.teal, 0));
  g.fillStyle = halo;
  g.fillRect(x - 160, y - 160, 320, 320);
}

export interface ComposerLayout {
  x: number;
  y: number;
  width: number;
  size: number;
  /** The full text and how it breaks: line i holds the text's characters from `starts[i]`. */
  lines: readonly string[];
}

/** Where character `i` of the composer's text sits: its line, its column, and its centre; null for the break between lines. */
export function charAt(g: G, ctx: Ctx, c: ComposerLayout, i: number): { x: number; y: number } | null {
  let offset = 0;
  const adv = metric(g, fontOf(ctx, 'mono', 700, c.size), 'M').width;
  for (const [row, text] of c.lines.entries()) {
    if (i < offset + text.length) {
      const col = i - offset;
      return { x: c.x + 56 + (col + 0.5) * adv, y: baselineOf(c, row) - c.size * 0.34 };
    }
    if (i === offset + text.length) {
      return null;
    }
    offset += text.length + 1;
  }
  return null;
}

export function baselineOf(c: ComposerLayout, row: number): number {
  return c.y + c.size * 1.12 + row * c.size * 1.2;
}

export function composerHeight(c: ComposerLayout): number {
  return c.size * (1.12 + 1.2 * (c.lines.length - 1)) + c.size * 0.62;
}

/** The send button's centre. */
export function sendAt(c: ComposerLayout): { x: number; y: number } {
  return { x: c.x + c.width - 70, y: c.y + composerHeight(c) / 2 };
}

export interface ComposerState {
  /** Whether character i shows, and the frame it appeared (for its pop-in), or null for long since. */
  shown: (i: number) => { at: number | null } | false;
  /** Where the cursor sits: after this character index. */
  cursor: number;
  /** The send button lit (0 to 1) and pressed (squash, 0 to 1). */
  lit: number;
  press: number;
  /** The frame's opacity. */
  alpha?: number;
  /** A character drawn in place of the text's own at index i, or null for the text's. */
  charOf?: (i: number) => string | null;
  /** The text's colour; cream unless set. */
  ink?: string;
  /** The pill's colour; lilac unless set. */
  edge?: string;
  /** A sent bubble: no send button and no cursor. */
  bubble?: boolean;
  /** A copy report for the text, or null when it is imagery here. */
  report: { id: string; words: string; role: TextBox['role'] } | null;
}

/**
 * The composer: a pill drawn from two parentheses and runs of em dashes, the
 * text in mono, each letter springing in from oversize as it is typed, a
 * cursor blinking on the beat, and the send arrow in an O at the right.
 */
export function composer(g: G, ctx: Ctx, frame: number, time: number, c: ComposerLayout, s: ComposerState): TextBox[] {
  void frame;
  const alpha = s.alpha ?? 1;
  const h = composerHeight(c);
  g.save();
  g.globalAlpha *= alpha;
  // The pill: a parenthesis at each end, em dashes along the top and bottom, the dashes boiling slightly.
  const edge = s.edge ?? P.lilac;
  glyph(g, ctx, '(', c.x + 16, c.y + h / 2, h * 1.18, { face: 'sans', weight: 200, color: edge, alpha: 0.85, sx: 0.9 });
  glyph(g, ctx, ')', c.x + c.width - 16, c.y + h / 2, h * 1.18, { face: 'sans', weight: 200, color: edge, alpha: 0.85, sx: 0.9 });
  for (let x = c.x + 48, k = 0; x < c.x + c.width - 48; x += 46, k++) {
    const j = boil(time, k, 6, 3) * 1.2;
    glyph(g, ctx, '—', x + 23, c.y + 6 + j, 56, { face: 'sans', weight: 300, color: edge, alpha: 0.7 });
    glyph(g, ctx, '—', x + 23, c.y + h - 6 - j, 56, { face: 'sans', weight: 300, color: edge, alpha: 0.7 });
  }
  // The send arrow in its ring, lit amber once there is something to send.
  const send = sendAt(c);
  if (s.bubble !== true) {
  const squash = s.press;
  const ring = s.lit > 0 ? P.amber : P.dim;
  glyph(g, ctx, 'O', send.x, send.y, 118, { face: 'sans', weight: 300, color: ring, sx: 1 + 0.2 * squash, sy: 1 - 0.25 * squash });
  glyph(g, ctx, '↑', send.x, send.y - 2, 64, { face: 'sans', weight: 800, color: s.lit > 0 ? P.amberHot : P.dim, sy: 1 - 0.3 * squash });
  if (s.lit > 0) {
    const halo = g.createRadialGradient(send.x, send.y, 0, send.x, send.y, 120);
    halo.addColorStop(0, rgba(P.amber, 0.28 * s.lit + 0.3 * squash));
    halo.addColorStop(1, rgba(P.amber, 0));
    g.fillStyle = halo;
    g.fillRect(send.x - 120, send.y - 120, 240, 240);
  }
  }
  const hide = s.report !== null && s.report.role !== 'imagery' && ctx.hideText;
  const font = fontOf(ctx, 'mono', 700, c.size);
  const adv = metric(g, font, 'M').width;
  let offset = 0;
  for (const [row, text] of c.lines.entries()) {
    const base = baselineOf(c, row);
    for (let col = 0; col < text.length; col++) {
      const shown = s.shown(offset + col);
      const ch = s.charOf?.(offset + col) ?? text.charAt(col);
      if (shown !== false && ch !== ' ' && !hide) {
        const since = shown.at === null ? 99 : time - shown.at;
        const pop = since < 10 ? 0.55 * Math.exp(-since / 2.6) : 0;
        glyph(g, ctx, ch, c.x + 56 + (col + 0.5) * adv, base, c.size, {
          face: 'mono',
          weight: 700,
          color: s.ink ?? P.cream,
          sx: 1 + pop * 0.6,
          sy: 1 + pop,
          anchor: 'baseline',
        });
      }
    }
    offset += text.length + 1;
  }
  if (s.bubble !== true && s.cursor >= 0 && beatPulse(time, 14, 1.2) > 0.45) {
    const at = cursorPoint(c, s.cursor, adv);
    glyph(g, ctx, '|', at.x + 4, at.y - c.size * 0.36, c.size * 1.1, { face: 'sans', weight: 300, color: P.amber });
  }
  g.restore();
  if (s.report === null) {
    return [];
  }
  const m = metric(g, font, 'h');
  const longest = Math.max(...c.lines.map((l) => l.length));
  const top = baselineOf(c, 0) - m.ascent;
  const bottom = baselineOf(c, c.lines.length - 1) + c.size * 0.22;
  return [
    {
      id: s.report.id,
      text: s.report.words,
      box: screenBox(g, c.x + 56, top, longest * adv, bottom - top),
      fontSizePx: c.size * screenScale(g),
      role: s.report.role,
    },
  ];
}

/** Where the cursor sits after `typed` characters of the composer's text. */
function cursorPoint(c: ComposerLayout, typed: number, adv: number): { x: number; y: number } {
  let offset = 0;
  for (const [row, text] of c.lines.entries()) {
    if (typed <= offset + text.length) {
      return { x: c.x + 56 + (typed - offset) * adv, y: baselineOf(c, row) };
    }
    offset += text.length + 1;
  }
  const last = c.lines.length - 1;
  return { x: c.x + 56 + (c.lines[last]?.length ?? 0) * adv, y: baselineOf(c, last) };
}

/** The beat-locked breathing every idle letter shares, offset per part. */
export function breathe(time: number, k: number): number {
  return Math.sin((time / 28) * Math.PI + k) * 0.5 + 0.5 * clamp(beatPulse(time + k * 3, 28, 4));
}
