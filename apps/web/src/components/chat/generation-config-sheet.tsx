import * as React from 'react';
import { Overlay, OverlayContent } from '@hushbox/ui';
import {
  ImageAspectRatioControl,
  VideoAspectRatioControl,
  VideoResolutionControl,
  VideoDurationControl,
  MediaCostLine,
} from './modality-config-panel';

interface GenerationConfigSheetProps {
  modality: 'image' | 'video';
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function SheetSection({
  title,
  children,
}: Readonly<{ title: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <section className="flex flex-col items-center gap-2">
      <h3 className="text-muted-foreground self-start text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function CostRow({
  modality,
}: Readonly<{ modality: 'image' | 'video' }>): React.JSX.Element {
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
}: Readonly<GenerationConfigSheetProps>): React.JSX.Element {
  const ariaLabel =
    modality === 'image' ? 'Image generation settings' : 'Video generation settings';

  return (
    <Overlay open={open} onOpenChange={onOpenChange} ariaLabel={ariaLabel}>
      <OverlayContent size="md">
        {modality === 'image' ? (
          <>
            <SheetSection title="Aspect ratio">
              <ImageAspectRatioControl pillSize="lg" />
            </SheetSection>
            <CostRow modality="image" />
          </>
        ) : (
          <>
            <SheetSection title="Aspect ratio">
              <VideoAspectRatioControl pillSize="lg" />
            </SheetSection>
            <SheetSection title="Resolution">
              <VideoResolutionControl />
            </SheetSection>
            <SheetSection title="Duration">
              <div className="w-full max-w-xs">
                <VideoDurationControl hideInlineLabel />
              </div>
            </SheetSection>
            <CostRow modality="video" />
          </>
        )}
      </OverlayContent>
    </Overlay>
  );
}
