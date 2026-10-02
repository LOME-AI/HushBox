import { MARK_AT, logoControl } from '../logo-control.js';

/** A blue far from the logo's red, bright enough to stand against the brand background. */
const RECOLOUR = 'rgb(71, 160, 236)';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * Every traced part filled at 1:1 where it rests, in {@link RECOLOUR}.
 * @toolContract
 */
export const renderFrame = logoControl(({ context: paint, logo }) => {
  paint.fillStyle = RECOLOUR;
  paint.translate(MARK_AT.x, MARK_AT.y);
  for (const part of logo.parts) {
    paint.fill(part.path);
  }
});
