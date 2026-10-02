import { BAR_FRAMES, SETTLE_FRAME } from './film.js';

import type { RenderFrame } from '../../look/index.js';

/** Where the decoded logo file is drawn at 1:1, on whole pixels. */
export const IMAGE_AT = { x: 300, y: 200 } as const;

/** Where the traced mark comes to rest at 1:1, on whole pixels. */
export const MARK_AT = { x: 300, y: 1240 } as const;

/** A marker at the foot of the frame, clear of both logos, that sweeps across once a bar. */
const SWEEP_Y = 1800;
const SWEEP_PX = 24;

/** How far a part starts from its rest, in pixels, and how far it turns, in turns. */
const FLIGHT_PX = 360;
const FLIGHT_TURNS = 0.6;

/** How much of its flight a part still has to make at an instant: 1 at the start, 0 from the settle on. */
function remaining(time: number): number {
  const done = Math.min(Math.max(time / SETTLE_FRAME, 0), 1);
  return (1 - done) ** 3;
}

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The logo file drawn as decoded above, and below it each traced part of the
 * mark flying in from its own seeded direction and turn about the mark's
 * centre, resting exactly on the file's shape from the settle frame on; a
 * marker sweeps the foot of the frame so the picture never holds still.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (_frame, ctx) => {
  const { context: paint, width, height, time, brand, logo } = ctx;
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  paint.drawImage(logo.image, IMAGE_AT.x, IMAGE_AT.y);
  paint.fillStyle = brand.foreground;
  paint.fillRect(
    ((time % BAR_FRAMES) / BAR_FRAMES) * (width - SWEEP_PX),
    SWEEP_Y,
    SWEEP_PX,
    SWEEP_PX
  );

  const left = remaining(time);
  const centreX = logo.width / 2;
  const centreY = logo.height / 2;
  paint.fillStyle = brand.brandRed;
  for (const [index, part] of logo.parts.entries()) {
    const flight = ctx.random(`part-${String(index)}`);
    const heading = flight() * Math.PI * 2;
    const turn = (flight() * 2 - 1) * FLIGHT_TURNS * Math.PI * 2;
    paint.save();
    paint.translate(
      MARK_AT.x + centreX + Math.cos(heading) * FLIGHT_PX * left,
      MARK_AT.y + centreY + Math.sin(heading) * FLIGHT_PX * left
    );
    paint.rotate(turn * left);
    paint.translate(-centreX, -centreY);
    paint.fill(part.path);
    paint.restore();
  }
  return [];
};
