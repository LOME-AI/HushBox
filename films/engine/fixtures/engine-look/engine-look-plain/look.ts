import type { RenderFrame } from '../../../look/index.js';

/** The prefix of the console line carrying the look's own canvas as a PNG data URL. */
export const DRAWN_PREFIX = 'engine-look-drawn:';

const BANDS = 24;
const TEXT_PX = 96;

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * A field of every grey and hue band the gradients reach, a Signal Red block
 * and a line of anti-aliased text, all moving with the frame; each call then
 * writes the canvas it drew to the console, so the probe can compare the frame
 * with the pixels the look put in its own canvas.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (frame, ctx) => {
  const { context: paint, canvas, width, height, brand } = ctx;
  const across = paint.createLinearGradient(0, 0, width, 0);
  across.addColorStop(0, '#000000');
  across.addColorStop(1, '#ffffff');
  paint.fillStyle = across;
  paint.fillRect(0, 0, width, height / 2);
  const bandHeight = height / 2 / BANDS;
  for (let band = 0; band < BANDS; band += 1) {
    paint.fillStyle = `hsl(${String((band * 360) / BANDS + frame)} 80% 50%)`;
    paint.fillRect(0, height / 2 + band * bandHeight, width, bandHeight);
  }
  paint.fillStyle = brand.brandRed;
  paint.fillRect(120 + frame * 4, 700, 320, 320);
  const sans = ctx.fonts['sans'];
  if (sans === undefined) {
    throw new Error('engine-look-plain: the look host loaded no sans stack');
  }
  paint.font = `700 ${String(TEXT_PX)}px ${sans}`;
  paint.fillStyle = brand.foreground;
  paint.fillText('Pixels as drawn', 120, 1200);
  console.warn(`${DRAWN_PREFIX} ${String(frame)} ${canvas.toDataURL('image/png')}`);
  return [];
};
