import { phaseAt, TEXTURE_SHIFT } from './timeline.js';

import type { RenderFrame, UiPlacement } from '../../look/index.js';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * A flat field in the brand's background, and on a texture frame the UI's
 * pixels laid over it moved down by `TEXTURE_SHIFT`, so the probe can tell the
 * texture's copy of an overlay from one drawn live where the UI sits.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (_frame, ctx) => {
  const { context: paint, width, height, brand, ui } = ctx;
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  if (ui !== null) {
    paint.drawImage(ui, 0, TEXTURE_SHIFT);
  }
  return [];
};

/** @toolContract */
export function placeUi(frame: number): UiPlacement {
  return phaseAt(frame).placement;
}

/** @toolContract */
export { Ui } from './ui.js';
