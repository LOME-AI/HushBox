import * as React from 'react';
import { useIsMobile } from '@hushbox/ui';
import { GenerationSummaryChip } from '@/components/chat/media/generation-summary-chip';
import { GenerationConfigSheet } from '@/components/chat/media/generation-config-sheet';
import {
  VideoAspectRatioControl,
  VideoResolutionControl,
  VideoDurationControl,
  AudioFormatControl,
  AudioDurationControl,
  MediaCostLine,
} from '@/components/chat/media/modality-config-panel';
import type { MediaDimensionAvailability, NoticeReason, ChatModality } from '@hushbox/shared';

/**
 * The per-axis verdicts the generation controls grey from, or `undefined` while
 * the composer holds none. It travels as a prop rather than being read where it
 * renders because the money layer prices the turn on the PROMPT, and the prompt
 * lives here — the controls sit three mounts below it.
 */
interface MediaAxisVerdictProps {
  readonly mediaDimensions?: readonly MediaDimensionAvailability[] | undefined;
  /**
   * The composer's send refusal, forwarded as the money layer's own typed
   * reason. Nothing on the way down reads it: one of its values means no
   * funding figure was read at all, and only the control that would otherwise
   * offer unpriced options can say what to render instead. Deriving a flag for
   * that here would put a second reading of the gate's verdict outside the gate.
   */
  readonly sendRefusal?: NoticeReason | undefined;
}

interface BottomRowsProps extends MediaAxisVerdictProps {
  readonly activeModality: ChatModality | undefined;
  readonly toolbar: React.ReactNode;
  readonly sendButton: React.ReactNode;
  readonly audioModalityEnabled: boolean;
}

export function TextBottomRow({
  toolbar,
  sendButton,
}: Readonly<Pick<BottomRowsProps, 'toolbar' | 'sendButton'>>): React.JSX.Element {
  return (
    <div className="flex items-center justify-end gap-2 px-3 py-2 empty:hidden">
      {toolbar}
      {sendButton}
    </div>
  );
}

function MobileGenerationRow({
  modality,
  toolbar,
  sendButton,
  mediaDimensions,
  sendRefusal,
}: Readonly<
  MediaAxisVerdictProps & {
    modality: 'image' | 'video';
    toolbar: React.ReactNode;
    sendButton: React.ReactNode;
  }
>): React.JSX.Element {
  const [sheetOpen, setSheetOpen] = React.useState(false);
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <GenerationSummaryChip
          modality={modality}
          onClick={() => {
            setSheetOpen(true);
          }}
        />
      </div>
      {toolbar}
      {sendButton}
      <GenerationConfigSheet
        modality={modality}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        dimensions={mediaDimensions}
        sendRefusal={sendRefusal}
      />
    </div>
  );
}

/** The image turn's row holds its estimate; its ratio is the composer bar's ratio chip. */
export function ImageBottomRow({
  toolbar,
  sendButton,
}: Readonly<Pick<BottomRowsProps, 'toolbar' | 'sendButton'>>): React.JSX.Element {
  return (
    <div className="flex items-center justify-end gap-2 px-3 py-2 empty:hidden">
      <MediaCostLine modality="image" />
      {toolbar}
      {sendButton}
    </div>
  );
}

export function VideoBottomRow({
  toolbar,
  sendButton,
  mediaDimensions,
  sendRefusal,
}: Readonly<
  Pick<BottomRowsProps, 'toolbar' | 'sendButton' | 'mediaDimensions' | 'sendRefusal'>
>): React.JSX.Element {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <MobileGenerationRow
        modality="video"
        toolbar={toolbar}
        sendButton={sendButton}
        mediaDimensions={mediaDimensions}
        sendRefusal={sendRefusal}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <VideoDurationControl dimensions={mediaDimensions} sendRefusal={sendRefusal} />
        <div className="mr-2 ml-auto">
          <MediaCostLine modality="video" />
        </div>
        <div className="flex items-center gap-2">
          {toolbar}
          {sendButton}
        </div>
      </div>
      <div className="flex items-stretch gap-3">
        <div className="flex flex-1 justify-center">
          <VideoAspectRatioControl dimensions={mediaDimensions} sendRefusal={sendRefusal} />
        </div>
        <div className="bg-border w-px" aria-hidden />
        <div className="flex flex-1 justify-center">
          <VideoResolutionControl dimensions={mediaDimensions} sendRefusal={sendRefusal} />
        </div>
      </div>
    </div>
  );
}

function AudioBottomRow({
  toolbar,
  sendButton,
}: Readonly<Pick<BottomRowsProps, 'toolbar' | 'sendButton'>>): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <AudioFormatControl />
      <AudioDurationControl />
      <div className="mr-2 ml-auto">
        <MediaCostLine modality="audio" />
      </div>
      <div className="flex items-center gap-2">
        {toolbar}
        {sendButton}
      </div>
    </div>
  );
}

/**
 * Whether a mode draws the text row: no mode, text, or audio where audio is not
 * offered, which falls back to it. The composer's context gauge shows on exactly
 * these modes, so both read this one answer.
 */
export function drawsTextRow(modality: ChatModality | undefined, audioOffered: boolean): boolean {
  if (modality === 'audio') return !audioOffered;
  return modality === undefined || modality === 'text';
}

export function BottomRows({
  activeModality,
  toolbar,
  sendButton,
  mediaDimensions,
  sendRefusal,
  audioModalityEnabled,
}: Readonly<BottomRowsProps>): React.JSX.Element {
  if (drawsTextRow(activeModality, audioModalityEnabled)) {
    return <TextBottomRow toolbar={toolbar} sendButton={sendButton} />;
  }
  if (activeModality === 'image') {
    return <ImageBottomRow toolbar={toolbar} sendButton={sendButton} />;
  }
  if (activeModality === 'video') {
    return (
      <VideoBottomRow
        toolbar={toolbar}
        sendButton={sendButton}
        mediaDimensions={mediaDimensions}
        sendRefusal={sendRefusal}
      />
    );
  }
  return <AudioBottomRow toolbar={toolbar} sendButton={sendButton} />;
}
