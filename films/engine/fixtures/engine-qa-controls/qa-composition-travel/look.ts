import { definition } from './film.js';

import type { LookContext, RenderFrame } from '../../../look/index.js';

type Paint = LookContext<'2d'>;

/** A Signal Red disc rising from the bottom and swelling as it goes. */
function risingDisc({ context: paint, width, height, brand }: Paint, progress: number): void {
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  paint.fillStyle = brand.brandRed;
  paint.beginPath();
  paint.arc(width * 0.35, height * (0.85 - 0.6 * progress), 160 + 260 * progress, 0, 2 * Math.PI);
  paint.fill();
}

/** Bands of the background colour stacking down a light field, the newest sliding in from the right. */
function stackingBands({ context: paint, width, height, brand }: Paint, progress: number): void {
  const bands = 10;
  const bandHeight = height / bands;
  const placed = progress * bands;
  paint.fillStyle = brand.foreground;
  paint.fillRect(0, 0, width, height);
  paint.fillStyle = brand.background;
  for (let band = 0; band < placed; band++) {
    const slide = Math.min(1, placed - band);
    paint.fillRect(width * (1 - slide), band * bandHeight, width, bandHeight * 0.8);
  }
}

/** A grid of squares on Signal Red, filling in one after another. */
function fillingGrid({ context: paint, width, height, brand }: Paint, progress: number): void {
  const columns = 4;
  const rows = 6;
  const cell = width / columns;
  const top = (height - rows * cell) / 2;
  paint.fillStyle = brand.brandRed;
  paint.fillRect(0, 0, width, height);
  paint.fillStyle = brand.background;
  const filled = 1 + progress * (columns * rows - 1);
  for (let square = 0; square < filled; square++) {
    const grow = Math.min(1, filled - square);
    const side = cell * 0.8 * grow;
    const x = (square % columns) * cell + (cell - side) / 2;
    const y = top + Math.floor(square / columns) * cell + (cell - side) / 2;
    paint.fillRect(x, y, side, side);
  }
}

/** A dark bar widening across a light field from the left edge. */
function sweepingBar({ context: paint, width, height, brand }: Paint, progress: number): void {
  paint.fillStyle = brand.foreground;
  paint.fillRect(0, 0, width, height);
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width * (0.2 + 0.75 * progress), height);
}

/** Rings of Signal Red and the foreground colour widening out from the centre of a dark field. */
function wideningRings({ context: paint, width, height, brand }: Paint, progress: number): void {
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  const outer = 200 + 700 * progress;
  for (let ring = 4; ring >= 1; ring--) {
    paint.fillStyle = ring % 2 === 0 ? brand.brandRed : brand.foreground;
    paint.beginPath();
    paint.arc(width / 2, height / 2, (outer * ring) / 4, 0, 2 * Math.PI);
    paint.fill();
  }
}

const COMPOSITIONS = [risingDisc, stackingBands, fillingGrid, sweepingBar, wideningRings] as const;

/** Each composition's share of the film, in frames; the last may end a fraction early. */
const SCENE_FRAMES = definition.spec.durationInFrames / COMPOSITIONS.length;

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * Five compositions in turn, each for a fifth of the film, each building from
 * its first frame to a state it did not start in.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const scene = Math.floor(frame / SCENE_FRAMES);
  const draw = COMPOSITIONS[scene];
  if (draw === undefined) {
    throw new Error(`qa-composition-travel: no composition for frame ${String(frame)}`);
  }
  draw(ctx, frame / SCENE_FRAMES - scene);
  return [];
};
