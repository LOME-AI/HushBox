import type { RenderFrame } from '../../look/index.js';

/**
 * The fixture film draws on a 2D canvas. The look host loads it by path, so no
 * module imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * A Signal Red bar sweeping down the frame.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const { context: paint, width, height, brand } = ctx;
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  paint.fillStyle = brand.brandRed;
  paint.fillRect(0, (frame * 16) % height, width, 80);
  return [];
};
