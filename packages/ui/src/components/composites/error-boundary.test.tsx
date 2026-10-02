import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { friendlyErrorMessage } from '@hushbox/shared';
import { ErrorBoundary } from './error-boundary';

function Boom(): React.JSX.Element {
  throw new Error('shell exploded');
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs caught render errors to console.error; silence the expected noise.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>healthy shell</div>
      </ErrorBoundary>
    );

    expect(screen.getByText('healthy shell')).toBeInTheDocument();
  });

  it('catches a render throw and shows a readable fallback instead of a blank page', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByText(friendlyErrorMessage('INTERNAL'))).toBeInTheDocument();
  });

  it('builds its fallback on the shared alert primitive rather than a hand-rolled live region', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('rounded-md');
    expect(alert).toHaveClass('text-destructive');
  });

  it('never resolves a throw message through the error-code copy map', () => {
    function ThrowsCodeShapedMessage(): React.JSX.Element {
      throw new Error('RATE_LIMITED');
    }

    render(
      <ErrorBoundary>
        <ThrowsCodeShapedMessage />
      </ErrorBoundary>
    );

    expect(screen.getByText(friendlyErrorMessage('INTERNAL'))).toBeInTheDocument();
    expect(screen.queryByText(friendlyErrorMessage('RATE_LIMITED'))).not.toBeInTheDocument();
  });

  it('falls back to the internal message when a child throws a non-Error value', () => {
    function ThrowsNonError(): React.JSX.Element {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- the boundary's handling of a non-Error throw is the behavior under test
      throw undefined;
    }

    render(
      <ErrorBoundary>
        <ThrowsNonError />
      </ErrorBoundary>
    );

    expect(screen.getByText(friendlyErrorMessage('INTERNAL'))).toBeInTheDocument();
  });

  it('re-attempts the children when retry is pressed after the fault is healed', async () => {
    function Flaky({ shouldThrow }: Readonly<{ shouldThrow: boolean }>): React.JSX.Element {
      if (shouldThrow) {
        throw new Error('shell exploded');
      }
      return <div>recovered shell</div>;
    }

    function Harness(): React.JSX.Element {
      const [shouldThrow, setShouldThrow] = React.useState(true);
      return (
        <>
          {/* The heal control lives outside the boundary so it survives the
              fallback swap; retry then re-attempts the now-healthy children. */}
          <button
            type="button"
            onClick={() => {
              setShouldThrow(false);
            }}
          >
            heal
          </button>
          <ErrorBoundary>
            <Flaky shouldThrow={shouldThrow} />
          </ErrorBoundary>
        </>
      );
    }

    render(<Harness />);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /heal/i }));
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByText('recovered shell')).toBeInTheDocument();
  });

  it('gives a caller-supplied fallback the error and a reset it can wire to a retry', async () => {
    let shouldThrow = true;
    function Flaky(): React.JSX.Element {
      if (shouldThrow) {
        throw new Error('custom fault');
      }
      return <div>healed by the fallback</div>;
    }

    render(
      <ErrorBoundary
        fallback={({ error, reset }) => (
          <div>
            <p>caught {error?.message}</p>
            <button
              type="button"
              onClick={() => {
                shouldThrow = false;
                reset();
              }}
            >
              reset it
            </button>
          </div>
        )}
      >
        <Flaky />
      </ErrorBoundary>
    );

    expect(screen.getByText('caught custom fault')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'reset it' }));

    expect(screen.getByText('healed by the fallback')).toBeInTheDocument();
  });

  it('clears the error when resetKey changes', () => {
    let shouldThrow = true;
    function ResetKeyThrower(): React.JSX.Element {
      if (shouldThrow) {
        throw new Error('chunk load failed');
      }
      return <div>reset recovered</div>;
    }

    const { rerender } = render(
      <ErrorBoundary resetKey="a">
        <ResetKeyThrower />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    rerender(
      <ErrorBoundary resetKey="b">
        <ResetKeyThrower />
      </ErrorBoundary>
    );

    expect(screen.getByText('reset recovered')).toBeInTheDocument();
  });

  it('stays in the error state while resetKey is unchanged', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="same">
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="same">
        <div>healthy shell</div>
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('healthy shell')).not.toBeInTheDocument();
  });
});
