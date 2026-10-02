import { MARK_AT, logoControl } from '../logo-control.js';

/**
 * The frame after the resting run: between the probe frames 96 and 120, so
 * the run's last frame, 100, is no probe frame.
 */
const RESTS_UNTIL = 101;

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The logo file resting at 1:1 from the first frame to frame 100, exact but on
 * that last frame, where it is drawn one pixel right of its box.
 * @toolContract
 */
export const renderFrame = logoControl(
  ({ context: paint, logo }, frame) => {
    paint.drawImage(logo.image, MARK_AT.x + (frame === RESTS_UNTIL - 1 ? 1 : 0), MARK_AT.y);
  },
  { restsUntil: RESTS_UNTIL }
);
