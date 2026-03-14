import * as React from 'react';
import { shortenModelName } from '@hushbox/shared';
import { DotPulseIndicator } from './dot-pulse-indicator';

interface ThinkingIndicatorProps {
  modelName: string;
}

export function ThinkingIndicator({
  modelName,
}: Readonly<ThinkingIndicatorProps>): React.JSX.Element {
  const displayName = shortenModelName(modelName) || 'AI';
  const label = `${displayName} is thinking`;

  return (
    <div
      role="status"
      aria-label={label}
      data-testid="thinking-indicator"
      className="text-muted-foreground flex items-center gap-1 text-sm"
    >
      <span>{label}</span>
      <DotPulseIndicator />
    </div>
  );
}
