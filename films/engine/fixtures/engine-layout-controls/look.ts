import { SAFE_BOX, SIZE_FLOOR_PX } from '../../layout/index.js';
import { definition } from './film.js';

import type { LookContext, RenderFrame, TextBox } from '../../look/index.js';

type Row = (typeof definition.spec.text)[number];

/** Where each row is set: its left edge, its baseline, its size and the brand stack. */
const PLACES: Readonly<
  Record<string, { x: number; baseline: number; sizePx: number; stack: string }>
> = {
  headline: { x: 120, baseline: 440, sizePx: SIZE_FLOOR_PX.headline, stack: 'serif' },
  support: { x: 120, baseline: 600, sizePx: SIZE_FLOOR_PX.support, stack: 'sans' },
  cta: { x: 120, baseline: 780, sizePx: SIZE_FLOOR_PX.cta, stack: 'sans' },
  caption: { x: 20, baseline: 1600, sizePx: 32, stack: 'mono' },
};

const SWEEP_PX = 24;
const SWEEP_TOP = 1700;
const SWEEP_HEIGHT = 120;

function place(row: Row): { x: number; baseline: number; sizePx: number; stack: string } {
  const found = PLACES[row.id];
  if (found === undefined) {
    throw new Error(`engine-layout-controls: no place is set for text "${row.id}"`);
  }
  return found;
}

/** The safe box as a dashed outline, so a still shows what the claims gate holds copy to. */
function drawSafeBox({ context: paint, brand }: LookContext<'2d'>): void {
  paint.strokeStyle = brand.muted;
  paint.lineWidth = 2;
  paint.setLineDash([12, 8]);
  paint.strokeRect(SAFE_BOX.x + 1, SAFE_BOX.y + 1, SAFE_BOX.width - 2, SAFE_BOX.height - 2);
  paint.setLineDash([]);
}

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The safe box outlined, a line of each copy role at its size floor inside it,
 * a caption of imagery outside it, and a bar sweeping below.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const { context: paint, width, height, brand } = ctx;
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  drawSafeBox(ctx);
  paint.fillStyle = brand.brandRed;
  const span = definition.spec.durationInFrames;
  paint.fillRect(((frame % span) / span) * (width - SWEEP_PX), SWEEP_TOP, SWEEP_PX, SWEEP_HEIGHT);

  paint.textAlign = 'left';
  paint.textBaseline = 'alphabetic';
  const boxes: TextBox[] = [];
  for (const row of definition.spec.text.filter(({ from, to }) => frame >= from && frame < to)) {
    const { x, baseline, sizePx, stack } = place(row);
    const family = ctx.fonts[stack];
    if (family === undefined) {
      throw new Error(`engine-layout-controls: the look host loaded no ${stack} stack`);
    }
    paint.font = `500 ${String(sizePx)}px ${family}`;
    const metrics = paint.measureText(row.words);
    if (!ctx.hideText) {
      paint.fillStyle = row.role === 'imagery' ? brand.muted : brand.foreground;
      paint.fillText(row.words, x, baseline);
    }
    boxes.push({
      id: row.id,
      text: row.words,
      box: {
        x: x - metrics.actualBoundingBoxLeft,
        y: baseline - metrics.actualBoundingBoxAscent,
        width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
        height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
      },
      fontSizePx: sizePx,
      role: row.role,
    });
  }
  return boxes;
};
