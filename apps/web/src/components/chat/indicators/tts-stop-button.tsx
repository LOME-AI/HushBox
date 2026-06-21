import * as React from 'react';
import { Square } from 'lucide-react';
import { useTtsPlaybackStore } from '@hushbox/ui/accessibility/store';
import { stopTtsForMessage } from '@/lib/chat-tts-stream';

export interface TtsStopButtonProps {
  /** Id of the assistant message this button controls. */
  readonly messageId: string;
}

export function TtsStopButton({ messageId }: TtsStopButtonProps): React.JSX.Element | null {
  const isActive = useTtsPlaybackStore((s) => s.speakingStreamId === messageId);
  if (!isActive) return null;
  return (
    <button
      type="button"
      aria-label="Stop reading message aloud"
      onClick={() => {
        stopTtsForMessage(messageId);
      }}
      className="border-border text-muted-foreground hover:bg-accent hover:text-foreground inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase transition-colors"
    >
      <Square className="size-2.5 motion-safe:animate-pulse" aria-hidden />
      Stop reading
    </button>
  );
}
