import * as React from 'react';
import { Button, cn } from '@hushbox/ui';
import { RatioShape } from '@/components/chat/media/ratio-chip';

interface AspectRatioPillProps {
  /** Ratio string like "16:9" or "1:1". */
  ratio: string;
  isActive: boolean;
  onClick: () => void;
  /**
   * Present when the money layer refused this option. The pill stays focusable
   * (aria-disabled, never the native attribute) so the reason it points at
   * remains reachable — greyed, never hidden, with a discoverable why.
   */
  unavailable?: { readonly reasonId: string };
}

export function AspectRatioPill({
  ratio,
  isActive,
  onClick,
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
        'flex h-14 w-14 flex-col items-center justify-center gap-1 p-0',
        // opacity-60, not lower: a greyed option must stay perceivable for
        // low-vision users while reading as non-interactive.
        unavailable && 'cursor-not-allowed opacity-60'
      )}
    >
      <RatioShape ratio={ratio} size="tile" />
      <span className="text-xs leading-none">{ratio}</span>
    </Button>
  );
}
