import { definition } from './score.js';

import type { RenderFrame } from '../../../../../look/index.js';

const { durationInFrames } = definition.spec;

/**
 * The take draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * A Signal Red disc gliding from the top left to the bottom right across the
 * whole take, swelling as it goes.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const { context: paint, width, height, brand } = ctx;
  const progress = frame / durationInFrames;
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  paint.fillStyle = brand.brandRed;
  paint.beginPath();
  paint.arc(
    width * (0.15 + 0.7 * progress),
    height * (0.1 + 0.8 * progress),
    120 + 240 * progress,
    0,
    2 * Math.PI
  );
  paint.fill();
  return [];
};
