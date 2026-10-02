import { CARD, SNAPPY, clamp, easeIn, step } from './motion.js';
import { F } from './timeline.js';

import type { LookContext, TextBox } from '../../../../engine/look/index.js';
import type { Row } from './timeline.js';

type P = CanvasRenderingContext2D;

export interface Setting {
  x: number;
  top: number;
  maxWidth: number;
  size: number;
  color: string;
  /** The colour for a word centred at a screen point, where the field behind the type changes under it. */
  colorAt?: (x: number, y: number) => string;
  align?: 'left' | 'center';
  /** Pixels each word trembles by, re-rolled a few times a second: the Devil's fear. */
  tremble?: number;
  /** A per-word jitter source in -1..1, keyed by word and tick. */
  jitter?: (word: number, tick: number) => number;
  /** Where the words are revealed from: a whole-row rise, or one group per listed beat. */
  groups?: readonly { words: number; beat: number }[];
  lineHeight?: number;
  /** Frames between one word's rise and the next's; words rising close together all rise on the snappy spring. */
  stagger?: number;
}

export function fontOf(row: Row, size: number, ctx: LookContext<'2d'>): string {
  const family = (name: string): string => {
    const found = ctx.fonts[name];
    if (found === undefined) {
      throw new Error(`one-take-launch: the look host loaded no ${name} stack`);
    }
    return found;
  };
  switch (row.voice) {
    case 'devil':
      return `italic 700 ${String(size)}px ${family('serif')}`;
    case 'secret':
      return `600 ${String(size)}px ${family('sans')}`;
    case 'brand':
    case 'keynote':
      return `700 ${String(size)}px ${family('sans')}`;
  }
}

function wrap(g: P, words: readonly string[], maxWidth: number): string[][] {
  const lines: string[][] = [];
  let line: string[] = [];
  for (const word of words) {
    const next = [...line, word];
    if (line.length > 0 && g.measureText(next.join(' ')).width > maxWidth) {
      lines.push(line);
      line = [word];
    } else {
      line = next;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * Draws a row as keynote type: each word rises from behind its line's mask on a
 * spring, staggered, and sinks back out at the row's end. Returns its box.
 */
export function drawRow(
  frame: number,
  row: Row,
  set: Setting,
  ctx: LookContext<'2d'>
): TextBox | null {
  const from = F(row.inBeat);
  const to = F(row.outBeat);
  if (frame < from || frame >= to) {
    return null;
  }
  const g = ctx.context;
  g.save();
  g.font = fontOf(row, set.size, ctx);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const words = row.words.split(' ');
  const lines = wrap(g, words, set.maxWidth);
  const lh = set.size * (set.lineHeight ?? 1.12);
  const space = g.measureText(' ').width;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let upper = Number.POSITIVE_INFINITY;
  let lower = Number.NEGATIVE_INFINITY;
  let index = 0;
  const exitStart = to - 10;
  for (const [li, line] of lines.entries()) {
    const width = g.measureText(line.join(' ')).width;
    const x0 = set.align === 'center' ? set.x - width / 2 : set.x;
    const baseline = set.top + set.size * 0.9 + li * lh;
    const m = g.measureText(line.join(' '));
    left = Math.min(left, x0 - m.actualBoundingBoxLeft);
    right = Math.max(right, x0 + m.actualBoundingBoxRight);
    upper = Math.min(upper, baseline - m.actualBoundingBoxAscent);
    lower = Math.max(lower, baseline + m.actualBoundingBoxDescent);
    let x = x0;
    for (const word of line) {
      const w = g.measureText(word).width;
      if (!ctx.hideText) {
        const stagger = set.stagger ?? 3;
        let start = from + index * stagger;
        if (set.groups !== undefined) {
          let seen = 0;
          for (const group of set.groups) {
            if (index < seen + group.words) {
              start = F(group.beat) - 4 + (index - seen) * 3;
              break;
            }
            seen += group.words;
          }
        }
        const rise = step(frame - start, index % 2 === 0 || stagger < 3 ? SNAPPY : CARD);
        const out = easeIn(clamp((frame - exitStart - (index % 4)) / 9));
        const dy = (1 - rise) * lh * 0.95 - out * lh * 0.95;
        let jx = 0;
        let jy = 0;
        if (set.tremble !== undefined && set.jitter !== undefined) {
          const tick = Math.floor(frame / 3);
          jx = set.jitter(index * 2, tick) * set.tremble;
          jy = set.jitter(index * 2 + 1, tick) * set.tremble;
        }
        if (frame >= start) {
          g.save();
          g.beginPath();
          g.rect(x - set.size, baseline - lh * 0.98, w + set.size * 2, lh * 1.12);
          g.clip();
          g.fillStyle = set.colorAt === undefined ? set.color : set.colorAt(x + w / 2, baseline - set.size * 0.35);
          g.fillText(word, x + jx, baseline + dy + jy);
          g.restore();
        }
      }
      x += w + space;
      index += 1;
    }
  }
  g.restore();
  return {
    id: row.id,
    text: row.words,
    box: { x: left, y: upper, width: right - left, height: lower - upper },
    fontSizePx: set.size,
    role: row.role,
  };
}
