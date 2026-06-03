import * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { useModelStore } from '@/stores/model';

interface GenerationSummaryChipProps {
  modality: 'image' | 'video';
  onClick: () => void;
}

const SHAPE_PX = 16;

/**
 * Inline visual rectangle matching the aspect ratio. Same idea as
 * AspectRatioPill but smaller and not a button (so the chip itself is the
 * sole click target).
 */
function InlineAspectShape({ ratio }: Readonly<{ ratio: string }>): React.JSX.Element {
  const [widthRaw, heightRaw] = ratio.split(':');
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  const isLandscape = width >= height;
  const shapeStyle: React.CSSProperties = {
    aspectRatio: `${String(width)} / ${String(height)}`,
    ...(isLandscape ? { width: `${String(SHAPE_PX)}px` } : { height: `${String(SHAPE_PX)}px` }),
  };
  return (
    <span
      data-testid="aspect-ratio-shape"
      aria-hidden="true"
      className="inline-block shrink-0 border border-current"
      style={shapeStyle}
    />
  );
}

// Cost is intentionally omitted from the chip — it lives in the bottom sheet
// under "Estimated cost". On mobile the composer row shares its width with
// the toolbar + send button, so the chip stays compact (shape + summary +
// chevron) and truncates the summary text when needed.
const CHIP_CLASS =
  'border-border bg-background hover:bg-accent flex h-11 w-full items-center gap-2 rounded-md border px-3 text-sm transition-colors';

export function GenerationSummaryChip({
  modality,
  onClick,
}: Readonly<GenerationSummaryChipProps>): React.JSX.Element {
  const imageConfig = useModelStore((s) => s.imageConfig);
  const videoConfig = useModelStore((s) => s.videoConfig);

  if (modality === 'image') {
    return (
      <button
        type="button"
        onClick={onClick}
        className={CHIP_CLASS}
        aria-label={`Image settings: ${imageConfig.aspectRatio} aspect ratio. Tap to edit.`}
      >
        <InlineAspectShape ratio={imageConfig.aspectRatio} />
        <span className="min-w-0 flex-1 truncate text-left">{imageConfig.aspectRatio}</span>
        <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={CHIP_CLASS}
      aria-label={`Video settings: ${videoConfig.aspectRatio} aspect ratio, ${String(
        videoConfig.durationSeconds
      )} seconds, ${videoConfig.resolution}. Tap to edit.`}
    >
      <InlineAspectShape ratio={videoConfig.aspectRatio} />
      <span data-testid="video-summary-text" className="min-w-0 flex-1 truncate text-left">
        {`${videoConfig.aspectRatio} · ${String(videoConfig.durationSeconds)}s · ${videoConfig.resolution}`}
      </span>
      <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
    </button>
  );
}
