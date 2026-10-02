import { MARK_AT, logoControl, markBox } from '../logo-control.js';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The mark's box filled with the brand red and every traced part filled
 * back in the brand background, so the mark reads as a hole in a red field.
 * @toolContract
 */
export const renderFrame = logoControl(({ context: paint, logo, brand }) => {
  const box = markBox(logo);
  paint.fillRect(box.x, box.y, box.width, box.height);
  paint.fillStyle = brand.background;
  paint.translate(MARK_AT.x, MARK_AT.y);
  for (const part of logo.parts) {
    paint.fill(part.path);
  }
});
