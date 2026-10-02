import { COUNTER } from '../palette.js';

import type { RenderFrame } from '../../../look/index.js';

const STEP_PX = 24;
const STEPS = 40;
const BAR_PX = 48;
const SWEEP_PX = 24;
const SWEEP_FRAMES = 96;

/**
 * The calls this module has drawn in its page: state a look must never read.
 * A page that renders every frame in turn counts them all; a fresh page
 * counts one.
 */
let calls = 0;

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * A bar sweeping across the brand's field, and over it a bar whose width
 * counts the calls the page has made.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  calls += 1;
  const { context: paint, width, height, brand } = ctx;
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  paint.fillStyle = brand.foreground;
  paint.fillRect(((frame % SWEEP_FRAMES) / SWEEP_FRAMES) * (width - SWEEP_PX), 0, SWEEP_PX, height);
  paint.fillStyle = COUNTER;
  paint.fillRect(0, 0, STEP_PX * (calls % STEPS), BAR_PX);
  return [];
};
