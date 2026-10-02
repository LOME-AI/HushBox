import { MARK_AT, logoControl } from '../logo-control.js';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The logo file at 1:1, one pixel right of where the mark is reported to rest.
 * @toolContract
 */
export const renderFrame = logoControl(({ context: paint, logo }) => {
  paint.drawImage(logo.image, MARK_AT.x + 1, MARK_AT.y);
});
