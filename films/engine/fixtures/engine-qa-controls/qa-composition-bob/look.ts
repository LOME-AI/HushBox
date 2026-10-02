import type { RenderFrame } from '../../../look/index.js';

/** Each part: where it rests, as shares of the frame, its size in pixels, and its bob. */
const PARTS = [
  { x: 0.3, y: 0.3, size: 220, amplitude: 50, periodFrames: 48 },
  { x: 0.7, y: 0.45, size: 160, amplitude: 70, periodFrames: 66 },
  { x: 0.4, y: 0.65, size: 260, amplitude: 40, periodFrames: 78 },
  { x: 0.65, y: 0.8, size: 120, amplitude: 60, periodFrames: 54 },
] as const;

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * One scene that never changes: four squares, alternately Signal Red and the
 * foreground colour, each bobbing up and down about its own rest.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const { brand, context: paint, height, width } = ctx;
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);
  for (const [index, part] of PARTS.entries()) {
    const bob = part.amplitude * Math.sin((2 * Math.PI * frame) / part.periodFrames);
    paint.fillStyle = index % 2 === 0 ? brand.brandRed : brand.foreground;
    paint.fillRect(
      part.x * width - part.size / 2,
      part.y * height - part.size / 2 + bob,
      part.size,
      part.size
    );
  }
  return [];
};
