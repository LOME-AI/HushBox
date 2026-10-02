import { MARK_AT, logoControl, markBox } from '../logo-control.js';

/** The logo file's red, (236, 71, 85), one level darker on its red channel. */
const GROUND = 'rgb(235, 71, 85)';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The mark's box filled with {@link GROUND} and the logo file drawn at 1:1 over it.
 * @toolContract
 */
export const renderFrame = logoControl(({ context: paint, logo }) => {
  const box = markBox(logo);
  paint.fillStyle = GROUND;
  paint.fillRect(box.x, box.y, box.width, box.height);
  paint.drawImage(logo.image, MARK_AT.x, MARK_AT.y);
});
