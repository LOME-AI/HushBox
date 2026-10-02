import type { RenderFrame, UiPlacement } from '../../../look/index.js';

/**
 * The look draws the brand's field on a 2D canvas, under its UI layer. The
 * look host loads it by path, so no module imports these exports.
 * @toolContract
 */
export const context = '2d';

/** @toolContract */
export const renderFrame: RenderFrame<'2d'> = (_frame, ctx) => {
  ctx.context.fillStyle = ctx.brand.background;
  ctx.context.fillRect(0, 0, ctx.width, ctx.height);
  return [];
};

/** @toolContract */
export function placeUi(): UiPlacement {
  return 'front';
}

/** @toolContract */
export { Ui } from './ui.js';
