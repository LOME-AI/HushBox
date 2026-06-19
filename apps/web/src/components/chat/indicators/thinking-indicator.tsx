import * as React from 'react';
import { shortenModelName, TEST_IDS } from '@hushbox/shared';
import { DotPulseIndicator } from '@/components/chat/indicators/dot-pulse-indicator';

interface ThinkingIndicatorProps {
  modelName: string;
  /**
   * Optional pre-inference stage label (e.g., "Choosing the best model…").
   * When provided, it replaces the "X is thinking" text — the model name is
   * suppressed because the slot doesn't yet know which model will run.
   */
  stageLabel?: string;
}

/**
 * Pre-inference / text-streaming indicator. Media turns never render this —
 * they carry `mediaInFlight` from the first frame and show the media backdrop
 * instead — so this only ever shows "X is thinking" or a pre-inference stage
 * label.
 */
export function ThinkingIndicator({
  modelName,
  stageLabel,
}: Readonly<ThinkingIndicatorProps>): React.JSX.Element {
  const displayName = shortenModelName(modelName) || 'AI';
  const label = stageLabel ?? `${displayName} is thinking`;

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
