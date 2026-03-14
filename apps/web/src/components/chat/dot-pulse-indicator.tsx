import * as React from 'react';

const DOT_DELAYS = ['0s', '0.16s', '0.32s'] as const;

export function DotPulseIndicator(): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      {DOT_DELAYS.map((delay) => (
        <span
          key={delay}
          className="animate-dot-pulse inline-block h-1 w-1 rounded-full bg-current"
          style={{ animationDelay: delay }}
        />
      ))}
    </span>
  );
}
