import { MARK_AT, logoControl } from '../logo-control.js';

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The logo file drawn at twice its width and its own height from x 60, and
 * reported resting in a box of that stretched size.
 * @toolContract
 */
export const renderFrame = logoControl(
  ({ context: paint, logo }) => {
    paint.drawImage(logo.image, 60, MARK_AT.y, logo.width * 2, logo.height);
  },
  {
    restsIn: (_frame, logo) => ({
      x: 60,
      y: MARK_AT.y,
      width: logo.width * 2,
      height: logo.height,
    }),
  }
);
