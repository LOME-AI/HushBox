import { beatAt, TEXTURE_DROP } from './timeline.js';

import type { RenderFrame, UiPlacement } from '../../look/index.js';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * A field of the brand's muted ink everywhere, so the dark UI and its scrims
 * stand off it; on a texture frame the UI's pixels over it, dropped by
 * `TEXTURE_DROP`, so a copy in the texture sits apart from anything drawn live
 * where the UI is.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (
  _frame,
  { context: paint, brand, ui, width, height }
) => {
  paint.fillStyle = brand.muted;
  paint.fillRect(0, 0, width, height);
  if (ui === null) {
    return [];
  }
  paint.drawImage(ui, 0, TEXTURE_DROP);
  return [];
};

/** @toolContract */
export function placeUi(frame: number): UiPlacement {
  return beatAt(frame).placement;
}

/** @toolContract */
export { Ui } from './ui.js';
