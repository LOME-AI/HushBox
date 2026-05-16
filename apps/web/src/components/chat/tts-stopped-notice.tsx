import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
import { useTtsPlaybackStore } from '@hushbox/ui/accessibility/store';

export interface TtsStoppedNoticeProps {
  /** Id of the assistant message above which the notice should appear. */
  readonly messageId: string;
}

export function TtsStoppedNotice({
  messageId,
}: TtsStoppedNoticeProps): React.JSX.Element | null {
  const stopped = useTtsPlaybackStore((s) => s.stoppedStreamIds.has(messageId));
  if (!stopped) return null;
  return (
    <p className="text-muted-foreground mb-1 text-xs">
      You can disable auto-read in{' '}
      <Link to={ROUTES.ACCESSIBILITY} className="text-primary hover:underline">
        Accessibility settings
      </Link>
    </p>
  );
}
