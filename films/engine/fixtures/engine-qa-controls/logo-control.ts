import type { LogoBox, LookContext, LookLogo, RenderFrame } from '../../look/index.js';

/** Where every logo control reports its resting mark at 1:1, on whole pixels. */
export const MARK_AT = { x: 300, y: 700 } as const;

const SWEEP_Y = 1800;
const SWEEP_PX = 24;
const SWEEP_FRAMES = 96;

/** The box a logo control reports its mark resting in by default: the file's size at {@link MARK_AT}. */
export function markBox(logo: LookLogo): LogoBox['box'] {
  return { ...MARK_AT, width: logo.width, height: logo.height };
}

/**
 * A logo control's look: the brand field, a marker sweeping its foot, and the
 * mark as `drawMark` misdraws it, reported as resting in `restsIn`'s box
 * ({@link markBox} when absent) on every frame before `restsUntil` (every
 * frame when absent) and neither drawn nor reported from it on.
 */
export function logoControl(
  drawMark: (ctx: LookContext<'2d'>, frame: number) => void,
  {
    restsUntil = Number.POSITIVE_INFINITY,
    restsIn = (_frame, logo) => markBox(logo),
  }: {
    restsUntil?: number;
    restsIn?: (frame: number, logo: LookLogo) => LogoBox['box'];
  } = {}
): RenderFrame<'2d'> {
  return (frame, ctx) => {
    const { context: paint, width, height, brand, logo } = ctx;
    paint.fillStyle = brand.background;
    paint.fillRect(0, 0, width, height);
    paint.fillStyle = brand.foreground;
    paint.fillRect(
      ((frame % SWEEP_FRAMES) / SWEEP_FRAMES) * (width - SWEEP_PX),
      SWEEP_Y,
      SWEEP_PX,
      SWEEP_PX
    );
    if (frame >= restsUntil) {
      return [];
    }
    paint.fillStyle = brand.brandRed;
    drawMark(ctx, frame);
    const mark: LogoBox = { id: 'mark', box: restsIn(frame, logo), role: 'logo' };
    return [mark];
  };
}
