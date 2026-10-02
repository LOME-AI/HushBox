import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { DotPulseIndicator } from '@/components/chat/indicators/dot-pulse-indicator';
import { thinkingLabel } from '@/components/chat/indicators/thinking-label';

interface ThinkingIndicatorProps {
  modelName: string;
}

/**
 * Text-streaming indicator. Media turns never render this — they carry
 * `mediaInFlight` from the first frame and show the media backdrop instead —
 * so this only ever shows "X is thinking".
 */
export function ThinkingIndicator({
  modelName,
}: Readonly<ThinkingIndicatorProps>): React.JSX.Element {
  const label = thinkingLabel(modelName);

  return (
    <div
      role="status"
      aria-label={label}
      data-testid={TEST_IDS.thinkingIndicator}
      className="text-muted-foreground flex items-center gap-1 text-sm"
    >
      <span>{label}</span>
      <DotPulseIndicator />
    </div>
  );
}
