import { GRID } from '../../../film.js';

import type { RenderFrame } from '../../../../../look/index.js';

const { framesPerBeat } = GRID;

/**
 * The take draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * A Signal Red square that swells on every beat and shrinks across it.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const { context: paint, width, height, brand } = ctx;
  const fall = (frame % framesPerBeat) / framesPerBeat;
  const side = 200 + 400 * (1 - fall);
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  paint.fillStyle = brand.brandRed;
  paint.fillRect((width - side) / 2, (height - side) / 2, side, side);
  return [];
};
