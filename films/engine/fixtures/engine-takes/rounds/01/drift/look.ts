import type { RenderFrame } from '../../../../../look/index.js';

const RADIUS = 140;

/**
 * The take draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * A disc drifting from the top left to the bottom right.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const { context: paint, width, height, brand } = ctx;
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  paint.fillStyle = brand.foreground;
  paint.beginPath();
  paint.arc(RADIUS + frame * 8, RADIUS + frame * 16, RADIUS, 0, Math.PI * 2);
  paint.fill();
  return [];
};
