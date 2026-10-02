import { MARK_AT, logoControl } from '../logo-control.js';

import type { LogoBox, LookLogo } from '../../../look/index.js';

/**
 * The first frame in the second box: between the probe frames 96 and 120, so
 * neither the first box's last frame, 100, nor this one is a probe frame.
 */
const SECOND_BOX_FROM = 101;

/** The frame after the second box's run, between the probe frames 192 and 216. */
const RESTS_UNTIL = 201;

/** The first box at {@link MARK_AT} and the second 500 px below it, each the file's size. */
function restsIn(frame: number, logo: LookLogo): LogoBox['box'] {
  const y = frame < SECOND_BOX_FROM ? MARK_AT.y : MARK_AT.y + 500;
  return { x: MARK_AT.x, y, width: logo.width, height: logo.height };
}

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The logo file at 1:1 in each frame's box, exact but on the first box's last
 * frame, where it is drawn one pixel right of that box.
 * @toolContract
 */
export const renderFrame = logoControl(
  ({ context: paint, logo }, frame) => {
    const box = restsIn(frame, logo);
    paint.drawImage(logo.image, box.x + (frame === SECOND_BOX_FROM - 1 ? 1 : 0), box.y);
  },
  { restsUntil: RESTS_UNTIL, restsIn }
);
