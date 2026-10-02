import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { useModelStore } from '@/stores/model';
import { Chip } from '@/components/shared/chip';

/** The catalog's value for letting the model pick the ratio itself. */
export const AUTO_ASPECT_RATIO = 'auto';

/** What a ratio is called on screen: the ratio as written, or "Auto". */
export function ratioLabel(ratio: string): string {
  return ratio === AUTO_ASPECT_RATIO ? 'Auto' : ratio;
}

/**
 * A shape's box in rem: the area it covers at 1:1, and the longest it may run
 * either way. Holding the area rather than the long side keeps a wide ratio and
 * a square reading as the same weight, and the caps keep the extreme ratios
 * inside the tile or chip that holds them.
 */
const SHAPE_BOX = {
  tile: { area: 1.5, maxWidth: 1.75, maxHeight: 1.5 },
  chip: { area: 0.5625, maxWidth: 1, maxHeight: 0.875 },
} as const;

/** The SVG's own units per rem, so its 1.5-unit stroke draws at the kit's 1.5px. */
const UNITS_PER_REM = 16;
const STROKE_UNITS = 1.5;
const CORNER_UNITS = 2;

/** Width over height; the automatic ratio draws as a square. */
function proportionOf(ratio: string): number {
  if (ratio === AUTO_ASPECT_RATIO) return 1;
  const colon = ratio.indexOf(':');
  return Number(ratio.slice(0, colon)) / Number(ratio.slice(colon + 1));
}

function shapeSizeRem(
  ratio: string,
  size: keyof typeof SHAPE_BOX
): { width: number; height: number } {
  const box = SHAPE_BOX[size];
  const proportion = proportionOf(ratio);
  const width = Math.sqrt(box.area * proportion);
  const height = Math.sqrt(box.area / proportion);
  const fit = Math.min(1, box.maxWidth / width, box.maxHeight / height);
  return { width: width * fit, height: height * fit };
}

/**
 * A ratio drawn as its outline: proportional for a stated ratio, a dashed square
 * for Auto. An SVG rather than a box: the composer squares a chip to its icon by
 * hiding the chip's spans, and the shape is that icon.
 */
export function RatioShape({
  ratio,
  size,
}: Readonly<{ ratio: string; size: keyof typeof SHAPE_BOX }>): React.JSX.Element {
  const { width, height } = shapeSizeRem(ratio, size);
  const viewWidth = width * UNITS_PER_REM;
  const viewHeight = height * UNITS_PER_REM;
  return (
    <svg
      data-testid={TEST_IDS.aspectRatioShape}
      aria-hidden="true"
      viewBox={`0 0 ${String(viewWidth)} ${String(viewHeight)}`}
      className="shrink-0"
      style={{ width: `${String(width)}rem`, height: `${String(height)}rem` }}
    >
      <rect
        x={STROKE_UNITS / 2}
        y={STROKE_UNITS / 2}
        width={viewWidth - STROKE_UNITS}
        height={viewHeight - STROKE_UNITS}
        rx={CORNER_UNITS}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE_UNITS}
        {...(ratio === AUTO_ASPECT_RATIO && { strokeDasharray: '3 2' })}
      />
    </svg>
  );
}

type RatioChipProps = Omit<React.ComponentProps<'button'>, 'children' | 'disabled'> & {
  /** Whether the popover it opens is open. */
  expanded?: boolean;
};

/**
 * The image composer's ratio control: the chosen ratio's shape and name. It
 * names itself "Aspect ratio: <ratio>" so a reader hears what it sets, and its
 * shape turns Signal Red while its popover is open.
 */
export function RatioChip({ expanded, ...props }: Readonly<RatioChipProps>): React.JSX.Element {
  const aspectRatio = useModelStore((s) => s.imageConfig.aspectRatio);
  const label = ratioLabel(aspectRatio);
  return (
    <Chip
      {...props}
      {...(expanded !== undefined && { expanded })}
      aria-label={`Aspect ratio: ${label}`}
      className="[&[aria-expanded=true]>svg]:text-brand-red"
    >
      <RatioShape ratio={aspectRatio} size="chip" />
      <span>{label}</span>
    </Chip>
  );
}
