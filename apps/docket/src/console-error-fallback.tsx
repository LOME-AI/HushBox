import { Button } from '@hushbox/ui';
import { TEST_IDS } from './test-ids';
import type { JSX } from 'react';

interface ConsoleErrorFallbackProps {
  readonly error: Error | null;
  readonly reset: () => void;
}

/**
 * What the console shows when a render throws. Passed to `ErrorBoundary` as its
 * `fallback`, which takes a render function rather than a node so the retry
 * button can reach `reset`.
 */
export function ConsoleErrorFallback({ error, reset }: ConsoleErrorFallbackProps): JSX.Element {
  return (
    <div
      data-testid={TEST_IDS.consoleErrorFallback}
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <h1 className="text-lg font-semibold">The console stopped</h1>
      <p className="text-muted-foreground text-sm">{error?.message ?? 'Unknown failure'}</p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
