import * as React from 'react';
import { Button, cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';

interface AspectRatioPillProps {
  /** Ratio string like "16:9" or "1:1". */
  ratio: string;
  isActive: boolean;
  onClick: () => void;
  /**
   * `sm` (default) renders a 22px shape in a 56×56 button for inline desktop use.
   * `lg` renders a 40px shape in a 72×72 button for the mobile bottom sheet
   * where tap targets need to be larger.
   */
  size?: 'sm' | 'lg';
  /**
   * Present when the money layer refused this option. The pill stays focusable
   * (aria-disabled, never the native attribute) so the reason it points at
   * remains reachable — greyed, never hidden, with a discoverable why.
   */
  unavailable?: { readonly reasonId: string };
}

const SHAPE_PX: Record<'sm' | 'lg', number> = { sm: 22, lg: 40 };

/**
 * Proportional rectangle whose width OR height is pinned to `sizePx` (longer
 * side wins) and whose other dimension is computed via `aspect-ratio` CSS.
 * Standalone so the summary chip can reuse the exact shape without nesting
 * an interactive button inside another button.
 */
export function AspectRatioShape({
  ratio,
  sizePx,
}: Readonly<{ ratio: string; sizePx: number }>): React.JSX.Element {
  const [widthRaw, heightRaw] = ratio.split(':');
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  const isLandscape = width >= height;
  const shapeStyle: React.CSSProperties = {
    aspectRatio: `${String(width)} / ${String(height)}`,
    ...(isLandscape ? { width: `${String(sizePx)}px` } : { height: `${String(sizePx)}px` }),
  };
  return (
    <span
      data-testid={TEST_IDS.aspectRatioShape}
      aria-hidden="true"
      className="inline-block shrink-0 border border-current"
      style={shapeStyle}
    />
  );
}

export function AspectRatioPill({
  ratio,
  isActive,
  onClick,
  size = 'sm',
  unavailable,
}: Readonly<AspectRatioPillProps>): React.JSX.Element {
  return (
    <Button
      type="button"
      size="sm"
      variant={isActive ? 'default' : 'outline'}
      aria-pressed={isActive}
      onClick={onClick}
      {...(unavailable && { 'aria-disabled': true, 'aria-describedby': unavailable.reasonId })}
      className={cn(
        'flex flex-col items-center justify-center gap-1 p-0',
        size === 'sm' ? 'h-14 w-14' : 'h-[72px] w-[72px]',
        // opacity-60, not lower: a greyed option must stay perceivable for
        // low-vision users while reading as non-interactive.
        unavailable && 'cursor-not-allowed opacity-60'
      )}
    >
      <AspectRatioShape ratio={ratio} sizePx={SHAPE_PX[size]} />
      <span className="text-xs leading-none">{ratio}</span>
    </Button>
  );
}
