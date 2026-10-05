import * as React from 'react';
import { useModelStore } from '@/stores/model';
import { Chip } from '@/components/shared/chip';
import { RatioShape, ratioLabel } from '@/components/chat/media/ratio-chip';

type VideoSettingsChipProps = Omit<React.ComponentProps<'button'>, 'children' | 'disabled'> & {
  /** Whether the popover it opens is open. */
  expanded?: boolean;
};

/**
 * The video composer's settings control: the chosen ratio's shape, then the duration
 * and resolution. The shape stands for the ratio, which keeps the label short enough
 * that a phone's composer bar stays on one line. Its name holds the label it shows,
 * after "Video settings:", so a voice command naming what is on screen reaches it, then
 * adds the ratio; its shape turns Signal Red while its popover is open.
 */
export function VideoSettingsChip({
  expanded,
  ...props
}: Readonly<VideoSettingsChipProps>): React.JSX.Element {
  const { aspectRatio, durationSeconds, resolution } = useModelStore((s) => s.videoConfig);
  const shown = `${String(durationSeconds)}s · ${resolution}`;
  return (
    <Chip
      {...props}
      {...(expanded !== undefined && { expanded })}
      aria-label={`Video settings: ${shown}, ${ratioLabel(aspectRatio)}`}
      className="[&[aria-expanded=true]>svg]:text-brand-red"
    >
      <RatioShape ratio={aspectRatio} size="chip" />
      <span>{shown}</span>
    </Chip>
  );
}
