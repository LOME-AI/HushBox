import * as React from 'react';
import { Button, cn } from '@hushbox/ui';

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
}

const SHAPE_PX: Record<'sm' | 'lg', number> = { sm: 22, lg: 40 };

export function AspectRatioPill({
  ratio,
  isActive,
  onClick,
  size = 'sm',
}: Readonly<AspectRatioPillProps>): React.JSX.Element {
  const [widthRaw, heightRaw] = ratio.split(':');
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  const isLandscape = width >= height;
  const dimension = SHAPE_PX[size];
  // Pin the longer side at `dimension` and let aspect-ratio compute the other.
  // The outer Button has fixed square footprint so every pill aligns into the
  // same row regardless of whether its shape is landscape, portrait, or square.
  const shapeStyle: React.CSSProperties = {
    aspectRatio: `${String(width)} / ${String(height)}`,
    ...(isLandscape ? { width: `${String(dimension)}px` } : { height: `${String(dimension)}px` }),
  };

  return (
    <Button
      type="button"
      size="sm"
      variant={isActive ? 'default' : 'outline'}
      aria-pressed={isActive}
      onClick={onClick}
      className={cn(
        'flex flex-col items-center justify-center gap-1 p-0',
        size === 'sm' ? 'h-14 w-14' : 'h-[72px] w-[72px]'
      )}
    >
      <span
        data-testid="aspect-ratio-shape"
        aria-hidden="true"
        className="block border border-current"
        style={shapeStyle}
      />
      <span className="text-xs leading-none">{ratio}</span>
    </Button>
  );
}
