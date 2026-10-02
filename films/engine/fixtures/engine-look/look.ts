import { SAFE_BOX } from '../../layout/index.js';
import { definition } from './film.js';
import { DISC, STAR } from './palette.js';

import type { RenderFrame, TextBox } from '../../look/index.js';
import type { PostSettings } from '../../visual/gl/index.js';

const { grid } = definition.spec;

const STARS = 90;
const DISCS = 5;
const ORBIT_PX = 300;
const DISC_PX = 34;
const MARK_PX = 120;
const TEXT_PX = 84;
const WORDS = 'Drawn from code.';
/** The open-licence family under the package's fonts directory the line is set in. */
const TEXT_FAMILY = 'katex-sans-serif';

/** How far into its beat an instant sits, 0 on the beat and rising towards 1. */
function beatPhase(time: number): number {
  const beats = time / grid.framesPerBeat;
  return beats - Math.floor(beats);
}

/**
 * The look draws on a 2D canvas. The look host loads it by path, so no module
 * imports these exports.
 * @toolContract
 */
export const context = '2d';

/**
 * Stars seeded once, discs orbiting the centre, a Signal Red square that punches
 * on every beat and the one line of copy, set in an open-licence family.
 * @toolContract
 */
export const renderFrame: RenderFrame<'2d'> = (_frame, ctx) => {
  const { context: paint, width, height, time, brand } = ctx;
  paint.fillStyle = brand.background;
  paint.fillRect(0, 0, width, height);

  const star = ctx.random('stars');
  paint.fillStyle = STAR;
  for (let index = 0; index < STARS; index += 1) {
    const drift = (time * (0.5 + star())) % height;
    paint.fillRect(star() * width, (star() * height + drift) % height, 3, 3);
  }

  const centreX = width / 2;
  const centreY = height / 2 - 200;
  paint.fillStyle = DISC;
  for (let index = 0; index < DISCS; index += 1) {
    const angle = (time / 90) * Math.PI * 2 + (index / DISCS) * Math.PI * 2;
    paint.beginPath();
    paint.arc(
      centreX + Math.cos(angle) * ORBIT_PX,
      centreY + Math.sin(angle) * ORBIT_PX * 0.6,
      DISC_PX,
      0,
      Math.PI * 2
    );
    paint.fill();
  }

  const punch = 1 + 0.35 * (1 - beatPhase(time));
  const side = MARK_PX * punch;
  paint.fillStyle = brand.brandRed;
  paint.fillRect(centreX - side / 2, centreY - side / 2, side, side);

  const face = ctx.fonts[TEXT_FAMILY];
  if (face === undefined) {
    throw new Error(`engine-look: the look host loaded no font family ${TEXT_FAMILY}`);
  }
  paint.font = `700 ${String(TEXT_PX)}px ${face}`;
  paint.textAlign = 'center';
  paint.textBaseline = 'alphabetic';
  const metrics = paint.measureText(WORDS);
  const baseline = SAFE_BOX.y + SAFE_BOX.height - 120;
  const textX = SAFE_BOX.x + SAFE_BOX.width / 2;
  if (!ctx.hideText) {
    paint.fillStyle = brand.foreground;
    paint.fillText(WORDS, textX, baseline);
  }
  const line: TextBox = {
    id: 'line',
    text: WORDS,
    box: {
      x: textX - metrics.actualBoundingBoxLeft,
      y: baseline - metrics.actualBoundingBoxAscent,
      width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
      height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
    },
    fontSizePx: TEXT_PX,
    role: 'headline',
  };
  return [line];
};

/**
 * The post chain: a steady bloom and vignette, and a chromatic split that
 * kicks on each beat and falls away over it.
 * @toolContract
 */
export function post(frame: number): PostSettings {
  return { bloom: 0.6, aberration: 0.8 * (1 - beatPhase(frame)), vignette: 0.4, flash: 0 };
}
