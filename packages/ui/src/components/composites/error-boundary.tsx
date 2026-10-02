import * as React from 'react';
import { friendlyErrorMessage } from '@hushbox/shared';

import { Alert } from '../primitives/alert';
import { Button } from '../primitives/button';

interface ErrorBoundaryFallbackState {
  readonly error: Error | null;
  /** Clears the error so the next render re-attempts the children. */
  readonly reset: () => void;
}

interface ErrorBoundaryProps {
  readonly children: React.ReactNode;
  readonly fallback?: (state: ErrorBoundaryFallbackState) => React.ReactNode;
  /**
   * When this value changes, the boundary clears its error state. Used by
   * streaming consumers where a transient failure on chunk N must not freeze
   * the fallback for chunk N+1.
   */
  readonly resetKey?: unknown;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
  readonly error: Error | null;
}

/**
 * A render crash's `message` is prose, never a registry code, so it must not be
 * fed to `friendlyErrorMessage` — a future `throw new Error('RATE_LIMITED')`
 * would otherwise put domain copy on the crash screen.
 */
function DefaultFallback({ reset }: ErrorBoundaryFallbackState): React.JSX.Element {
  return (
    <Alert
      variant="destructive"
      emphasis="subtle"
      data-slot="error-boundary-fallback"
      className="flex-col justify-center gap-4 p-8 text-center"
    >
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="text-muted-foreground text-sm">{friendlyErrorMessage('INTERNAL')}</p>
      <Button onClick={reset}>Try again</Button>
    </Alert>
  );
}

/**
 * Catches a render throw below it and degrades to a readable fallback rather
 * than blanking the tree. No telemetry: no client-side error SDK ships
 * (CODE-RULES).
 */
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    if (this.state.hasError && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  override render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    const fallbackState = { error: this.state.error, reset: this.handleReset };
    return this.props.fallback === undefined ? (
      <DefaultFallback {...fallbackState} />
    ) : (
      this.props.fallback(fallbackState)
    );
  }
}

export { ErrorBoundary, DefaultFallback as ErrorFallback };
