import { SAFE_BOX } from '../../layout/index.js';

import type { FilmSpec } from '../../film/spec.js';
import type { LookContext, RenderFrame, TextBox } from '../../look/index.js';

/** Where a control draws one spec text row, and how it misdraws or misreports it. */
export interface ControlLine {
  /** The spec's text row: its id, words, role and frames. */
  id: string;
  sizePx: number;
  /** The left edge and the baseline the words are set at. */
  x: number;
  baseline: number;
  /** The brand colour the words are set in; the foreground when absent. */
  tone?: 'foreground' | 'background';
  /** How far below the box it reports the look draws the words. */
  drawnBelowPx?: number;
  /** False reports the box and draws nothing in it. */
  drawn?: boolean;
  /** False draws the words and reports no box for them. */
  reported?: boolean;
  /** The frame the look stops drawing and reporting the line on; the row's own end when absent. */
  until?: number;
}

interface ControlOptions {
  /** Draws the words in the hidden-text pass too. */
  ignoresHideText?: boolean;
}

const STRIPE_PX = 6;
const STRIPE_ALPHA = 0.15;
const SWEEP_PX = 24;
const SWEEP_FRAMES = 96;
/** The sweep runs below the safe box, clear of every line of copy. */
const SWEEP_TOP = SAFE_BOX.y + SAFE_BOX.height + 100;
const SWEEP_HEIGHT = 200;

function row(spec: FilmSpec, id: string): FilmSpec['text'][number] {
  const found = spec.text.find((text) => text.id === id);
  if (found === undefined) {
    throw new Error(`${spec.id}: the spec declares no text "${id}"`);
  }
  return found;
}

/** The brand field striped with the muted colour, so text the field's colour still changes pixels, and a bar sweeping below the copy. */
function drawField(
  frame: number,
  { context: paint, width, height, brand }: LookContext<'2d'>
): void {
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  paint.globalAlpha = STRIPE_ALPHA;
  paint.fillStyle = brand.muted;
  for (let top = 0; top < height; top += 2 * STRIPE_PX) {
    paint.fillRect(0, top, width, STRIPE_PX);
  }
  paint.globalAlpha = 1;
  paint.fillStyle = brand.brandRed;
  const sweep = ((frame % SWEEP_FRAMES) / SWEEP_FRAMES) * (width - SWEEP_PX);
  paint.fillRect(sweep, SWEEP_TOP, SWEEP_PX, SWEEP_HEIGHT);
}

/** Draws the line unless the control misdraws it, and returns the box the control reports for it. */
function drawLine(
  spec: FilmSpec,
  line: ControlLine,
  ctx: LookContext<'2d'>,
  { ignoresHideText = false }: ControlOptions
): TextBox {
  const { context: paint, brand } = ctx;
  const { words, role } = row(spec, line.id);
  const face = ctx.fonts['sans'];
  if (face === undefined) {
    throw new Error(`${spec.id}: the look host loaded no sans stack`);
  }
  paint.font = `500 ${String(line.sizePx)}px ${face}`;
  paint.textAlign = 'left';
  paint.textBaseline = 'alphabetic';
  const metrics = paint.measureText(words);
  if ((line.drawn ?? true) && (!ctx.hideText || ignoresHideText)) {
    paint.fillStyle = brand[line.tone ?? 'foreground'];
    paint.fillText(words, line.x, line.baseline + (line.drawnBelowPx ?? 0));
  }
  return {
    id: line.id,
    text: words,
    box: {
      x: line.x - metrics.actualBoundingBoxLeft,
      y: line.baseline - metrics.actualBoundingBoxAscent,
      width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
      height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
    },
    fontSizePx: line.sizePx,
    role,
  };
}

/**
 * A text control's look: the striped field, a sweeping bar, and each line set
 * in the brand sans over its row's frames, drawn and reported as the line says.
 */
export function controlLook(
  spec: FilmSpec,
  lines: readonly ControlLine[],
  options: ControlOptions = {}
): RenderFrame<'2d'> {
  return (frame, ctx) => {
    drawField(frame, ctx);
    return lines
      .filter((line) => {
        const { from, to } = row(spec, line.id);
        return frame >= from && frame < (line.until ?? to);
      })
      .flatMap((line) => {
        const box = drawLine(spec, line, ctx, options);
        return line.reported === false ? [] : [box];
      });
  };
}
