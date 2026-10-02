import { BAR_FRAMES, FLIGHT_FRAME, SETTLE_FRAME } from './film.js';

import type { LogoBox, LookContext, RenderFrame } from '../../look/index.js';

/** Where the file rests at 1:1, on whole pixels. */
const ONE_TO_ONE = { x: 300, y: 600 } as const;

/** Where the mark rests at 2×, on whole pixels. */
const DOUBLED = { x: 60, y: 400 } as const;

/** A marker at the foot of the frame, clear of every mark, that sweeps across once a bar. */
const SWEEP_Y = 1800;
const SWEEP_PX = 24;

/** How far a part starts from its rest, in pixels, and how far it turns, in turns. */
const FLIGHT_PX = 420;
const FLIGHT_TURNS = 0.6;

function resting(x: number, y: number, scale: number, ctx: LookContext<'2d'>): LogoBox {
  return {
    id: 'mark',
    box: { x, y, width: ctx.logo.width * scale, height: ctx.logo.height * scale },
    role: 'logo',
  };
}

/** How much of its flight a part still has to make at an instant: 1 at the start, 0 from the settle on. */
function remaining(time: number): number {
  const done = Math.min(Math.max((time - FLIGHT_FRAME) / (SETTLE_FRAME - FLIGHT_FRAME), 0), 1);
  return (1 - done) ** 3;
}

/** Each traced part flying from its own seeded direction and turn to its rest at 2×. */
function flyIn(time: number, ctx: LookContext<'2d'>): void {
  const { context: paint, logo, brand } = ctx;
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
      DOUBLED.x + centreX * 2 + Math.cos(heading) * FLIGHT_PX * left,
      DOUBLED.y + centreY * 2 + Math.sin(heading) * FLIGHT_PX * left
    );
    paint.rotate(turn * left);
    paint.scale(2, 2);
    paint.translate(-centreX, -centreY);
    paint.fill(part.path);
    paint.restore();
  }
}

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * The logo file at 1:1 on the brand field, then at 2× over a gradient, then
 * the traced parts flying in to rest at 2×; each frame on which the mark rests
 * reports its box, and a marker sweeps the foot of the frame so the picture
 * never holds still.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const { context: paint, width, height, time, brand, logo } = ctx;
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  paint.fillStyle = brand.foreground;
  paint.fillRect(
    ((time % BAR_FRAMES) / BAR_FRAMES) * (width - SWEEP_PX),
    SWEEP_Y,
    SWEEP_PX,
    SWEEP_PX
  );
  if (frame < BAR_FRAMES) {
    paint.drawImage(logo.image, ONE_TO_ONE.x, ONE_TO_ONE.y);
    return [resting(ONE_TO_ONE.x, ONE_TO_ONE.y, 1, ctx)];
  }
  if (frame < FLIGHT_FRAME) {
    // A quarter of the way to the muted grey at the box's foot: a background that changes behind
    // the mark while staying dark enough for the brand red to hold 3:1 against it.
    const gradient = paint.createLinearGradient(0, DOUBLED.y, 0, DOUBLED.y + logo.height * 8);
    gradient.addColorStop(0, brand.background);
    gradient.addColorStop(1, brand.muted);
    paint.fillStyle = gradient;
    paint.fillRect(0, DOUBLED.y, width, logo.height * 2);
    paint.drawImage(logo.image, DOUBLED.x, DOUBLED.y, logo.width * 2, logo.height * 2);
    return [resting(DOUBLED.x, DOUBLED.y, 2, ctx)];
  }
  flyIn(time, ctx);
  return frame >= SETTLE_FRAME ? [resting(DOUBLED.x, DOUBLED.y, 2, ctx)] : [];
};
