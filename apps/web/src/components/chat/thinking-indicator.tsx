import * as React from 'react';

interface ThinkingIndicatorProps {
  modelName: string;
}

const DOT_DELAYS = ['0s', '0.16s', '0.32s'] as const;

export function ThinkingIndicator({
  modelName,
}: Readonly<ThinkingIndicatorProps>): React.JSX.Element {
  const displayName = modelName || 'AI';
  const label = `${displayName} is thinking`;

  return (
    <div
      role="status"
      aria-label={label}
      data-testid="thinking-indicator"
      className="text-muted-foreground flex items-center gap-1 text-sm"
    >
      <span>{label}</span>
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        {DOT_DELAYS.map((delay) => (
          <span
            key={delay}
            className="animate-dot-pulse inline-block h-1 w-1 rounded-full bg-current"
            style={{ animationDelay: delay }}
          />
        ))}
      </span>
    </div>
  );
}
