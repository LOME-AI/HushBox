import { SAFE_BOX } from '../../../../engine/layout/index.js';

import { spec } from './score.js';

import type { LookContext, TextBox } from '../../../../engine/look/index.js';

type Row = (typeof spec.text)[number];

interface Style {
  stack: string;
  weight: number;
  italic: boolean;
  size: number;
  color: string;
}

const DEVIL: Style = { stack: 'serif', weight: 700, italic: true, size: 88, color: '#f6e6cb' };
const VALUE: Style = { stack: 'sans', weight: 600, italic: false, size: 84, color: '#ffffff' };

function styleOf(row: Row, ctx: LookContext): Style {
  switch (row.id) {
    case 'lt':
      return { stack: 'mono', weight: 500, italic: false, size: 44, color: '#dccdb4' };
    case 'a8':
      return { ...DEVIL, size: 124 };
    case 'wm':
      return { stack: 'sans', weight: 700, italic: false, size: 104, color: ctx.brand.foreground };
    case 'tag1':
    case 'tag2':
    case 'tag3':
      return { stack: 'sans', weight: 500, italic: false, size: 84, color: ctx.brand.foreground };
    default:
      return row.id.startsWith('v') ? VALUE : DEVIL;
  }
}

/** Where a row's block sits: the lower third's line at the top of the safe box, the close's rows under the mark, every other line resting on the bottom of the band. */
function anchorOf(row: Row): { top?: number; bottom?: number } {
  if (row.id === 'lt') return { top: 330 };
  if (row.id === 'wm') return { top: 790 };
  if (row.id === 'tag1') return { top: 928 };
  if (row.id === 'tag2') return { top: 1024 };
  if (row.id === 'tag3') return { top: 1120 };
  return { bottom: 1196 };
}

const LINE_HEIGHT = 1.14;
/** Lines centre on the frame's centre line; a line too wide for that is pushed left only as far as the safe box needs. */
const CENTRE = 540;
const SAFE_RIGHT = SAFE_BOX.x + SAFE_BOX.width - 10;
/** Frames between one line's entry and the next. */
const STAGGER = 3;
/** Frames a line takes to lift out of its slot. */
const EXIT = 12;

/** A snappy spring's step response in frames: it overshoots its place and settles. */
function springIn(frames: number): number {
  if (frames <= 0) {
    return 0;
  }
  const s = frames / 60;
  const w = 2 * Math.PI * 3.2;
  const z = 0.5;
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * s) * (Math.cos(wd * s) + ((z * w) / wd) * Math.sin(wd * s));
}

function fontOf(style: Style, ctx: LookContext): string {
  const family = ctx.fonts[style.stack];
  if (family === undefined) {
    throw new Error(`origin-flight: the look host loaded no ${style.stack} stack`);
  }
  return `${style.italic ? 'italic ' : ''}${String(style.weight)} ${String(style.size)}px ${family}`;
}

/** Every sentence on its own line, and a sentence wider than the safe box broken at its words. */
function wrap(paint: CanvasRenderingContext2D, row: Row): string[] {
  const lines: string[] = [];
  for (const sentence of row.words.split(/(?<=[.?]) /u)) {
    let line = '';
    for (const word of sentence.split(' ')) {
      const next = line === '' ? word : `${line} ${word}`;
      if (line !== '' && paint.measureText(next).width > SAFE_BOX.width - 20) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The band the picture darkens behind the text: its strength and its top and bottom in pixels. */
export interface Scrim {
  alpha: number;
  top: number;
  bottom: number;
}

/**
 * Draws every row on screen at `time` (frames) into `paint`, word by word, each
 * word rising into place from a blur, and returns the boxes and the scrim.
 */
export function drawText(
  paint: CanvasRenderingContext2D,
  time: number,
  ctx: LookContext
): { boxes: TextBox[]; scrim: Scrim } {
  const boxes: TextBox[] = [];
  const scrim: Scrim = { alpha: 0, top: 0, bottom: 0 };
  const centre = CENTRE;
  for (const row of spec.text) {
    if (time < row.from || time >= row.to) {
      continue;
    }
    const style = styleOf(row, ctx);
    paint.font = fontOf(style, ctx);
    paint.letterSpacing = style.stack === 'sans' && style.size < 100 ? '-1px' : '0px';
    paint.textBaseline = 'alphabetic';
    paint.textAlign = 'left';
    const lines = wrap(paint, row);
    const step = style.size * LINE_HEIGHT;
    const anchor = anchorOf(row);
    const blockTop = anchor.top ?? (anchor.bottom ?? 0) - lines.length * step;
    const final = row.to >= spec.durationInFrames;
    const exit = final ? 0 : Math.min(1, Math.max(0, (time - (row.to - EXIT)) / EXIT));
    const exitEase = exit * exit;
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let upper = Number.POSITIVE_INFINITY;
    let lower = Number.NEGATIVE_INFINITY;
    let shown = 0;
    for (const [lineIndex, line] of lines.entries()) {
      const baseline = blockTop + (lineIndex + 1) * step - (LINE_HEIGHT - 1) * style.size * 0.5 - style.size * 0.14;
      const metrics = paint.measureText(line);
      const x0 = Math.min(centre - metrics.width / 2, SAFE_RIGHT - metrics.width);
      // Each line is revealed through its own slot: it rises out of the slot's lower edge on a
      // snappy spring that overshoots, and leaves by lifting out through the upper edge.
      const pad = style.size * 0.16;
      const slotTop = baseline - metrics.actualBoundingBoxAscent - pad;
      const slotBottom = baseline + metrics.actualBoundingBoxDescent + pad;
      const travel = slotBottom - slotTop;
      const settled = row.from === 0 ? 1 : springIn(time - (row.from + lineIndex * STAGGER));
      const offset = travel * (1 - settled) - travel * exitEase;
      const visible = offset < travel && offset > -travel;
      shown = Math.max(shown, visible ? 1 - Math.abs(offset) / travel : 0);
      left = Math.min(left, x0 - metrics.actualBoundingBoxLeft);
      right = Math.max(right, x0 + metrics.actualBoundingBoxRight);
      upper = Math.min(upper, slotTop);
      lower = Math.max(lower, slotBottom);
      if (ctx.hideText || !visible) {
        continue;
      }
      paint.save();
      paint.beginPath();
      paint.rect(0, slotTop, ctx.width, slotBottom - slotTop);
      paint.clip();
      paint.fillStyle = style.color;
      paint.fillText(line, x0, baseline + offset);
      paint.restore();
    }
    boxes.push({
      id: row.id,
      text: row.words,
      box: { x: left, y: upper, width: right - left, height: lower - upper },
      fontSizePx: style.size,
      role: row.role,
    });
    if (row.id !== 'wm' && !row.id.startsWith('tag')) {
      const alpha = 0.62 * shown;
      if (alpha > scrim.alpha) {
        scrim.alpha = alpha;
        scrim.top = upper - 40;
        scrim.bottom = lower + 34;
      }
    }
  }
  return { boxes, scrim };
}
