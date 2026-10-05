import {
  AudioFormatControl,
  AudioDurationControl,
  MediaCostLine,
} from '@/components/chat/media/modality-config-panel';
import type * as React from 'react';
import type { ChatModality } from '@hushbox/shared';

interface BottomRowsProps {
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

/**
 * The row under the text for each mode. An image or video turn draws none: its settings
 * open from a composer bar chip, and its estimate sits in the bar beside the model.
 */
export function BottomRows({
  activeModality,
  toolbar,
  sendButton,
  audioModalityEnabled,
}: Readonly<BottomRowsProps>): React.JSX.Element | null {
  if (drawsTextRow(activeModality, audioModalityEnabled)) {
    return <TextBottomRow toolbar={toolbar} sendButton={sendButton} />;
  }
  if (activeModality === 'image' || activeModality === 'video') return null;
  return <AudioBottomRow toolbar={toolbar} sendButton={sendButton} />;
}
