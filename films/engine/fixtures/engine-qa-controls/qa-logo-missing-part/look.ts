import { MARK_AT, logoControl } from '../logo-control.js';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * Every traced part of the mark filled at 1:1 where it rests, but the smallest.
 * @toolContract
 */
export const renderFrame = logoControl(({ context: paint, logo }) => {
  const smallest = Math.min(...logo.parts.map(({ area }) => area));
  paint.translate(MARK_AT.x, MARK_AT.y);
  for (const part of logo.parts.filter(({ area }) => area !== smallest)) {
    paint.fill(part.path);
  }
});
