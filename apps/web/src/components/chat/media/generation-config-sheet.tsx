import * as React from 'react';
import { Overlay, OverlayContent } from '@hushbox/ui';
import {
  ImageAspectRatioControl,
  VideoAspectRatioControl,
  VideoResolutionControl,
  VideoDurationControl,
  MediaCostLine,
  MediaFundingNotice,
} from '@/components/chat/media/modality-config-panel';
import type { MediaDimensionAvailability, NoticeReason } from '@hushbox/shared';

interface GenerationConfigSheetProps {
  modality: 'image' | 'video';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The turn's per-axis verdicts, or `undefined` while there is none. */
  dimensions?: readonly MediaDimensionAvailability[] | undefined;
  /**
   * The composer's send refusal, forwarded untouched to the same controls the
   * desktop row mounts — the two layouts must not answer a refusal differently.
   */
  sendRefusal?: NoticeReason | undefined;
}

function CostRow({ modality }: Readonly<{ modality: 'image' | 'video' }>): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-sm">Cost</span>
      <MediaCostLine modality={modality} />
    </div>
  );
}

export function GenerationConfigSheet({
  modality,
  open,
  onOpenChange,
  dimensions,
  sendRefusal,
}: Readonly<GenerationConfigSheetProps>): React.JSX.Element {
  const ariaLabel =
    modality === 'image' ? 'Image generation settings' : 'Video generation settings';

  return (
    <Overlay open={open} onOpenChange={onOpenChange} ariaLabel={ariaLabel}>
      <OverlayContent size="md">
        {/* The sheet is one row's worth of axes, so it says the unread funding
            figure once. It says it at all — where the desktop row does not, and
            the composer's notice list owns the sentence — because this sheet
            OCCLUDES that list: it is modal, its backdrop covers the viewport,
            and it is pinned to the same bottom edge the composer occupies. Each
            heading below is the control's own — a heading this file rendered
            would stay on screen when the control it labels took itself down,
            and no parent can see that a child rendered nothing. */}
        <MediaFundingNotice sendRefusal={sendRefusal} />
        {modality === 'image' ? (
          <>
            <ImageAspectRatioControl
              heading="Aspect ratio"
              pillSize="lg"
              dimensions={dimensions}
              sendRefusal={sendRefusal}
            />
            <CostRow modality="image" />
          </>
        ) : (
          <>
            <VideoAspectRatioControl
              heading="Aspect ratio"
              pillSize="lg"
              dimensions={dimensions}
              sendRefusal={sendRefusal}
            />
            <VideoResolutionControl
              heading="Resolution"
              dimensions={dimensions}
              sendRefusal={sendRefusal}
            />
            <VideoDurationControl
              heading="Duration"
              dimensions={dimensions}
              sendRefusal={sendRefusal}
            />
            <CostRow modality="video" />
          </>
        )}
      </OverlayContent>
    </Overlay>
  );
}
