import { logoPathData } from '../../../look/logo.js';
import { MARK_AT, logoControl } from '../logo-control.js';

/** Every how many outline points the fitted polygon keeps one: about 36 corners an arc. */
const KEEP_EVERY = 24;

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * Each traced part of the mark filled at 1:1 where it rests as the polygon
 * through every 24th point of its outline: close to the eye, not the file.
 * @toolContract
 */
export const renderFrame = logoControl(({ context: paint, logo }) => {
  paint.translate(MARK_AT.x, MARK_AT.y);
  for (const { outline } of logo.parts) {
    paint.fill(new Path2D(logoPathData(outline.filter((_, index) => index % KEEP_EVERY === 0))));
  }
});
